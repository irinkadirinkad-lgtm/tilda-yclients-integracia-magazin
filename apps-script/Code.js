/**
 * tilda-yclients-integracia-magazin
 * Интеграция магазина: YClients (источник правды) ↔ Тильда (интернет-магазин).
 * Замена МойСклада. Отдельный проект (изоляция): свои Script Properties и триггеры.
 *
 * Потоки:
 *   A. YClients → Тильда: остатки + цены + названия (CommerceML-фид), триггер ~5 мин.
 *   B. Тильда → YClients: заказ (вебхук корзины) → ПРОДАЖА товара по 0 (type_id=1), без финансовой операции.
 *
 * ⚠️ Части, помеченные TODO(боевая проверка), финализируются после тестов на реальном аккаунте
 * (см. STATUS.md: точный формат CommerceML, поля вебхука Тильды, поведение списания в финансах).
 */

// ─── Конфиг: всё чувствительное — в Script Properties, НЕ в коде ───────────────
var OWNER_EMAIL_ = 'irinkadirinkad@gmail.com';
var DIAG_SECRET_ = 'tz_yc_8b3f1a7d';   // гейт служебного doGet (диагностика/настройка). После обкатки сузить.
var YC_BASE_ = 'https://api.yclients.com/api/v1';
var YC_ACCEPT_ = 'application/vnd.yclients.v2+json';
var SYNC_INTERVAL_MIN_ = 5;

function props_() { return PropertiesService.getScriptProperties(); }
function prop_(k) { return props_().getProperty(k); }
function requireProp_(k) {
  var v = prop_(k);
  if (!v) throw new Error('Не задано Script Property: ' + k);
  return v;
}

// ─── YClients: авторизация и запросы ──────────────────────────────────────────
function ycHeaders_() {
  return {
    'Authorization': 'Bearer ' + requireProp_('PARTNER_TOKEN') + ', User ' + requireProp_('USER_TOKEN'),
    'Accept': YC_ACCEPT_,
    'Content-Type': 'application/json'
  };
}

function ycGet_(path, params) {
  var qs = '';
  if (params) {
    var parts = [];
    Object.keys(params).forEach(function (k) {
      if (params[k] != null) parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
    });
    if (parts.length) qs = '?' + parts.join('&');
  }
  var resp = UrlFetchApp.fetch(YC_BASE_ + path + qs, { method: 'get', headers: ycHeaders_(), muteHttpExceptions: true });
  return ycParse_(resp, 'GET ' + path);
}

function ycPost_(path, payload) {
  var resp = UrlFetchApp.fetch(YC_BASE_ + path, {
    method: 'post', headers: ycHeaders_(), payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  return ycParse_(resp, 'POST ' + path);
}

function ycDelete_(path) {
  var resp = UrlFetchApp.fetch(YC_BASE_ + path, { method: 'delete', headers: ycHeaders_(), muteHttpExceptions: true });
  return { code: resp.getResponseCode(), text: resp.getContentText().slice(0, 200) };
}

function ycParse_(resp, label) {
  var code = resp.getResponseCode(), text = resp.getContentText();
  if (code < 200 || code >= 300) throw new Error('YClients ' + label + ' → HTTP ' + code + ': ' + text.slice(0, 500));
  var json = JSON.parse(text);
  if (json && json.success === false) throw new Error('YClients ' + label + ' → success=false: ' + text.slice(0, 500));
  return json;
}

var _companyId_ = null;
function companyId_() { return _companyId_ || (_companyId_ = requireProp_('COMPANY_ID')); }

// ─── Склад магазина (for_sale) ────────────────────────────────────────────────
// Кэшируем id в Script Property STORE_STORAGE_ID, но всегда можем пересчитать.
function resolveStoreStorageId_() {
  var cached = prop_('STORE_STORAGE_ID');
  if (cached) return cached;
  var res = ycGet_('/storages/' + companyId_());
  var list = (res && res.data) || [];
  var sale = list.filter(function (s) { return Number(s.for_sale) === 1; });
  if (!sale.length) throw new Error('Не найден склад магазина (for_sale=1). Склады: ' + JSON.stringify(list.map(function (s) { return { id: s.id, title: s.title, for_sale: s.for_sale, for_service: s.for_service }; })));
  var id = String(sale[0].id);
  props_().setProperty('STORE_STORAGE_ID', id);
  return id;
}

// ─── Чтение товаров магазина: остаток, цена, артикул ──────────────────────────
// Возвращает [{good_id, title, article, barcode, price, amount}] по складу магазина.
// ⚠️ Эндпойнт /goods отдаёт по ~25 товаров на страницу (count не расширяет) → листаем страницами
// до пустой. Возвращает ВСЕ товары; остаток берём по складу магазина (for_sale, id 637823).
function fetchStoreGoods_() {
  var storageId = resolveStoreStorageId_();
  var out = [], page = 1, MAX_PAGES = 200;
  while (page <= MAX_PAGES) {
    var res = ycGet_('/goods/' + companyId_(), { page: page, count: 100 });
    var rows = (res && res.data) || [];
    if (!rows.length) break;
    rows.forEach(function (g) {
      var amt = 0, amounts = g.actual_amounts || [];
      for (var i = 0; i < amounts.length; i++) {
        if (String(amounts[i].storage_id) === String(storageId)) { amt = Number(amounts[i].amount) || 0; break; }
      }
      out.push({
        good_id: g.good_id || g.id,
        title: String(g.title || '').trim(),
        article: String(g.article || '').trim(),
        barcode: String(g.barcode || '').trim(),
        price: Number(g.cost) || 0,
        amount: amt
      });
    });
    page++;
  }
  return out;
}

// Ключ сопоставления с Тильдой (ПОДТВЕРЖДЁН на живых данных 23.07): External ID Тильды = '_' + good_id.
function tildaId_(goodId) { return '_' + goodId; }

// good_id из externalid заказа Тильды: '_11204299' → 11204299.
function goodIdFromExternal_(ext) {
  var s = String(ext || '').trim().replace(/^_/, '');
  return /^\d+$/.test(s) ? Number(s) : null;
}

// Карточки конкретных good_id (для точечного теста фида). Возвращает [{good_id,title,article,price,amount}].
function fetchGoodsByIds_(ids) {
  var storageId = resolveStoreStorageId_(), out = [], skipped = [];
  ids.forEach(function (id) {
    try {
      var res = ycGet_('/goods/' + companyId_() + '/' + id);
      var g = (res && res.data) || {};
      if (!(g.good_id || g.id)) { skipped.push(id); return; }
      var amt = 0;
      (g.actual_amounts || []).forEach(function (a) { if (String(a.storage_id) === String(storageId)) amt = Number(a.amount) || 0; });
      out.push({ good_id: g.good_id || id, title: String(g.title || '').trim(), article: String(g.article || '').trim(), price: Number(g.cost) || 0, amount: amt });
    } catch (e) { skipped.push(id); }   // нет в YClients / ошибка — пропускаем, не роняем партию
  });
  out._skipped = skipped;
  return out;
}

// ─── Поток B: продажа товара из заказа Тильды (по нулям, БЕЗ финансовой операции) ──
// Решения Ирины (23.07): операция = ПРОДАЖА товара (type_id=1) по 0 — засчитывается как продажа,
// но денег/долга не создаёт (проверено на боевом: paid:false, payment/kkm пусто, finance_tx=0).
// Ответственный мастер (обязателен в YClients) = WRITEOFF_MASTER_ID (Ирина 969478). Автор операции
// = пользователь токена («программист») — проставляется автоматически.
// items: [{good_id, amount}]. Возвращает документ-ответ YClients.
function createOnlineSale_(items, comment) {
  var master = Number(requireProp_('WRITEOFF_MASTER_ID'));
  var payload = {
    type_id: 1,                       // 1 = продажа товара
    storage_id: Number(resolveStoreStorageId_()),
    master_id: master,
    create_date: formatDate_(new Date()),
    comment: comment || "Заказ с интернет-магазина EL'NATUREL SHOP",
    goods_transactions: items.map(function (it) {
      return {
        good_id: Number(it.good_id),
        amount: Number(it.amount),
        cost_per_unit: 0,
        discount: 0,
        cost: 0,
        operation_unit_type: 1,       // 1 = продажа
        master_id: master
      };
    })
  };
  return ycPost_('/storage_operations/operation/' + companyId_(), payload);
}

// ─── Поток A: сборка CommerceML-фида и заливка в Тильду ────────────────────────
// Формат CommerceML 2.05: import.xml — <Каталог> с товарами; offers.xml — <ПакетПредложений>
// с ОБЪЯВЛЕНИЕМ <ТипыЦен> (иначе Тильда игнорирует цену!) + <Предложения>.
function buildImportXml_(goods) {
  var esc = xmlEsc_;
  var items = goods.map(function (g) {
    return '' +
      '<Товар>' +
        '<Ид>' + esc(tildaId_(g.good_id)) + '</Ид>' +   // = External ID Тильды (совпадение → без дублей)
        '<Артикул>' + esc(g.article) + '</Артикул>' +
        '<Наименование>' + esc(g.title) + '</Наименование>' +
      '</Товар>';
  }).join('');
  return commerceEnvelope_(
    '<Каталог СодержитТолькоИзменения="false">' +
      '<Ид>yc-catalog</Ид>' +
      '<Наименование>Каталог товаров</Наименование>' +
      '<Товары>' + items + '</Товары>' +
    '</Каталог>');
}

function buildOffersXml_(goods) {
  var esc = xmlEsc_;
  var priceId = requireProp_('TILDA_PRICE_ID');   // «ID цены в системе учёта» из настроек Тильды
  var offers = goods.map(function (g) {
    return '' +
      '<Предложение>' +
        '<Ид>' + esc(tildaId_(g.good_id)) + '</Ид>' +   // = External ID Тильды
        '<Артикул>' + esc(g.article) + '</Артикул>' +
        '<Наименование>' + esc(g.title) + '</Наименование>' +
        '<Цены><Цена>' +
          '<ИдТипаЦены>' + esc(priceId) + '</ИдТипаЦены>' +
          '<ЦенаЗаЕдиницу>' + (g.price || 0) + '</ЦенаЗаЕдиницу>' +
          '<Валюта>руб</Валюта>' +
        '</Цена></Цены>' +
        '<Количество>' + (g.amount || 0) + '</Количество>' +
      '</Предложение>';
  }).join('');
  return commerceEnvelope_(
    '<ПакетПредложений>' +
      '<Ид>yc-offers</Ид>' +
      '<Наименование>Пакет предложений</Наименование>' +
      '<ТипыЦен><ТипЦены>' +
        '<Ид>' + esc(priceId) + '</Ид>' +
        '<Наименование>Розничная</Наименование>' +
        '<Валюта>руб</Валюта>' +
      '</ТипЦены></ТипыЦен>' +
      '<Предложения>' + offers + '</Предложения>' +
    '</ПакетПредложений>');
}

function commerceEnvelope_(body) {
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<КоммерческаяИнформация ВерсияСхемы="2.05" ДатаФормирования="' + formatDate_(new Date()).replace(' ', 'T') + '">' + body + '</КоммерческаяИнформация>';
}

// Обмен по протоколу 1С-CommerceML (проверено на боевом коннекторе Тильды):
// checkauth → init → (file → import) для каждого файла. files = [{name, xml}].
function pushCommerceML_(files) {
  var base = requireProp_('TILDA_CML_URL');
  var auth = 'Basic ' + Utilities.base64Encode(requireProp_('TILDA_CML_LOGIN') + ':' + requireProp_('TILDA_CML_PASS'));
  // 1. checkauth → success\n{cookieName}\n{cookieValue}
  var r = UrlFetchApp.fetch(base + '?type=catalog&mode=checkauth', { headers: { Authorization: auth }, muteHttpExceptions: true });
  var lines = r.getContentText().split(/\r?\n/);
  if (lines[0] !== 'success') throw new Error('Tilda checkauth: ' + r.getContentText().slice(0, 200));
  var cookie = lines[1] + '=' + lines[2];
  var setc = r.getAllHeaders()['Set-Cookie'];
  if (setc) (Array.isArray(setc) ? setc : [setc]).forEach(function (c) { cookie += '; ' + String(c).split(';')[0]; });
  var hdr = { Authorization: auth, Cookie: cookie };
  // 2. init → zip=no\nfile_limit=NNN
  UrlFetchApp.fetch(base + '?type=catalog&mode=init', { headers: hdr, muteHttpExceptions: true });
  // 3-4. file + import для каждого файла
  var out = [];
  files.forEach(function (f) {
    var fr = UrlFetchApp.fetch(base + '?type=catalog&mode=file&filename=' + encodeURIComponent(f.name),
      { method: 'post', headers: hdr, contentType: 'application/xml; charset=UTF-8', payload: f.xml, muteHttpExceptions: true });
    if (fr.getContentText().indexOf('success') === -1) throw new Error('Tilda file ' + f.name + ': ' + fr.getContentText().slice(0, 200));
    var res = 'progress';
    for (var i = 0; i < 30 && res.indexOf('progress') === 0; i++) {
      var ir = UrlFetchApp.fetch(base + '?type=catalog&mode=import&filename=' + encodeURIComponent(f.name), { headers: hdr, muteHttpExceptions: true });
      res = ir.getContentText();
      if (res.indexOf('progress') === 0) Utilities.sleep(1500);
    }
    if (res.indexOf('success') !== 0) throw new Error('Tilda import ' + f.name + ': ' + res.slice(0, 200));
    out.push(f.name + ': ' + res.split(/\r?\n/)[0]);
  });
  return out.join(' | ');
}

// ─── ИНКРЕМЕНТ (триггер ~5 мин): шлём в Тильду только то, что изменилось ────────
// Лёгкий цикл: спрашиваем YClients, какие товары двигались с прошлого раза (складские
// транзакции changed_after), шлём в Тильду только их. Нет изменений → ничего не шлём.
function syncStockToTilda_() {
  var started = new Date();
  try {
    var d = changedGoodIdsNew_();                         // {ids, maxId} — новые складские операции по номеру
    if (d.ids.length) {
      addMasterIds_(d.ids);                               // новые товары — в master-список
      var goods = fetchGoodsByIds_(d.ids);
      var res = goods.length ? pushFeed_(goods) : 'нет карточек';
      logStatus_('Инкремент A', 'OK', 'изменённых: ' + goods.length + ' | ' + res, started);
    } else {
      logStatus_('Инкремент A', 'OK', 'изменений нет', started);
    }
    if (d.maxId) props_().setProperty('LAST_TX_ID', String(d.maxId));   // сдвигаем только после успешной заливки
    props_().setProperty('LAST_SYNC_TS', formatDate_(started));
  } catch (e) {
    reportError_('Инкремент A (5 мин)', e);
  }
}

// Новые складские операции с прошлого раза — по НОМЕРУ операции (id растёт; changed_after у YClients
// не работает). Окно — вчера+сегодня (перехлёст на полночь). Возвращает {ids: [good_id...], maxId}.
function changedGoodIdsNew_() {
  var storageId = String(resolveStoreStorageId_());
  var lastId = Number(prop_('LAST_TX_ID') || 0);
  var now = new Date();
  var d1 = formatDate_(new Date(now.getTime() - 24 * 3600 * 1000)).slice(0, 10);
  var d2 = formatDate_(now).slice(0, 10);
  var rows = [], page = 1;
  while (page <= 20) {                                    // подстраховка от пагинации
    var res = ycGet_('/storages/transactions/' + companyId_(), { start_date: d1, end_date: d2, count: 1000, page: page });
    var r = (res && res.data) || [];
    if (!r.length) break;
    rows = rows.concat(r);
    if (r.length < 1000) break;
    page++;
  }
  var maxId = lastId, set = {};
  rows.forEach(function (t) {
    var id = Number(t.id) || 0;
    if (id > maxId) maxId = id;
    if (id > lastId) {
      var g = t.good || {};
      if (g.id && (t.storage_id == null || String(t.storage_id) === storageId)) set[g.id] = 1;
    }
  });
  return { ids: Object.keys(set), maxId: maxId };
}

// ─── ПОЛНАЯ СВЕРКА (триггер раз в сутки, ночь): весь master-список остатков+цен → Тильда ──
function syncFullToTilda_() {
  var started = new Date();
  try {
    var ids = masterIds_();
    if (!ids.length) { logStatus_('Полная сверка A', 'OK', 'master пуст', started); return; }
    var pushed = 0;
    for (var i = 0; i < ids.length; i += 50) {           // партиями по 50, чтобы уложиться в лимиты
      var goods = fetchGoodsByIds_(ids.slice(i, i + 50));
      if (goods.length) { pushFeed_(goods); pushed += goods.length; }
    }
    props_().setProperty('LAST_SYNC_TS', formatDate_(started));
    logStatus_('Полная сверка A (ночь)', 'OK', 'сверено товаров: ' + pushed + ' из ' + ids.length, started);
  } catch (e) {
    reportError_('Полная сверка A (ночь)', e);
  }
}

// master-список good_id (что синхроним): хранится строкой в Script Property.
function masterIds_() { var s = prop_('MASTER_GOOD_IDS') || ''; return s ? s.split(',') : []; }
function addMasterIds_(ids) {
  var have = {}; masterIds_().forEach(function (x) { have[x] = 1; });
  var changed = false;
  ids.forEach(function (x) { x = String(x); if (!have[x]) { have[x] = 1; changed = true; } });
  if (changed) props_().setProperty('MASTER_GOOD_IDS', Object.keys(have).join(','));
}

// Собирает import.xml + offers.xml по товарам и заливает в Тильду одним обменом.
function pushFeed_(goods) {
  return pushCommerceML_([
    { name: 'import.xml', xml: buildImportXml_(goods) },
    { name: 'offers.xml', xml: buildOffersXml_(goods) }
  ]);
}

// ─── Поток B: приём заказа Тильды ──────────────────────────────────────────────
function doPost(e) {
  try {
    var order = parseTildaOrder_(e);
    // Не распознали заказ — НЕ молчим: в журнал + письмо, иначе заказ потеряется незаметно.
    if (!order.tranid) {
      var rawNoId = rawOrderPayload_(e);
      logStatus_('Заказ с сайта', 'ОШИБКА', 'не найден номер заказа; тело: ' + rawNoId, new Date());
      reportError_('Приём заказа с сайта', new Error('Не найден номер заказа (tranid). Тело: ' + rawNoId));
      return jsonOut_({ ok: false, error: 'no tranid' });
    }
    // Номер есть, но состава нет — тоже сигнал (формат полей мог измениться).
    if (!order.items.length) {
      logStatus_('Заказ с сайта', 'ВНИМАНИЕ', '#' + order.tranid + ' без состава; тело: ' + rawOrderPayload_(e), new Date());
    }
    if (isProcessed_(order.tranid)) return jsonOut_({ ok: true, dup: true });   // идемпотентность

    // externalid позиции Тильды = '_' + good_id → good_id получаем напрямую, без справочника.
    var items = [], unmatched = [];
    order.items.forEach(function (it) {
      var gid = goodIdFromExternal_(it.externalid || it.sku);
      if (gid) items.push({ good_id: gid, amount: it.quantity });
      else unmatched.push(it);
    });

    // Номер заказа берём ТОТ, ЧТО ПРИСЫЛАЕТ ТИЛЬДА (Ирина настроила передачу номера ЗАЯВКИ —
    // это её сквозная нумерация). Своего счётчика не держим и в скобках ничего не дублируем,
    // чтобы не было двух номеров (решение Ирины 25.07).
    if (items.length) {
      createOnlineSale_(items, "Заказ с интернет-магазина EL'NATUREL SHOP №" + order.tranid);
    }
    markProcessed_(order.tranid);
    if (unmatched.length) {
      logUnmatched_('order_no_match', unmatched.map(function (u) { return (u.name || '') + ' [' + (u.externalid || u.sku || '') + ']'; }));
      reportError_('Заказ с сайта №' + order.tranid, new Error('Не сопоставлены позиции: ' + unmatched.length));
    }
    logStatus_('Заказ с сайта', 'OK', '№' + order.tranid + ', списано позиций: ' + items.length +
      ' | поля вебхука: ' + payloadFields_(e), new Date());
    return jsonOut_({ ok: true, orderNo: order.tranid, written: items.length, unmatched: unmatched.length });
  } catch (err) {
    // Ошибку пишем И в журнал (раньше уходила только письмом — в журнале следа не оставалось).
    logStatus_('Заказ с сайта', 'ОШИБКА', String(err && err.message || err).slice(0, 250) +
      ' | поля вебхука: ' + payloadFields_(e), new Date());
    reportError_('Приём заказа с сайта (doPost)', err);
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  }
}

// Имена полей вебхука + значения «номерных» полей, без персональных данных клиента.
// Нужно, чтобы по первому реальному заказу увидеть, что именно присылает Тильда.
function payloadFields_(e) {
  try {
    var p = (e && e.parameter) || {}, keys = Object.keys(p);
    var body = null, raw = e && e.postData && e.postData.contents;
    if (raw && String(raw).trim().charAt(0) === '{') { try { body = JSON.parse(raw); } catch (ig) {} }
    if (body) keys = keys.concat(Object.keys(body).map(function (k) { return 'json:' + k; }));
    var nums = [];
    [p, body || {}].forEach(function (src) {
      Object.keys(src).forEach(function (k) {
        if (/id$|number|zayav|заявк|order/i.test(k) && typeof src[k] !== 'object') {
          nums.push(k + '=' + String(src[k]).slice(0, 40));
        }
      });
    });
    return keys.join(',') + (nums.length ? ' || номерные: ' + nums.join(' ') : '');
  } catch (e2) { return '?'; }
}

// Разбор вебхука заказа Тильды. Поддерживаем ОБА формата, т.к. Тильда может присылать и
// form-urlencoded (поля в e.parameter, состав — JSON-строкой в payment), и JSON-тело
// (e.postData.contents). Проверено 25.07: form-urlencoded работает; JSON — заложен, чтобы
// заказ не потерялся молча, если Тильда пришлёт его телом.
function parseTildaOrder_(e) {
  var p = (e && e.parameter) || {};
  var body = {};
  try {
    var raw = e && e.postData && e.postData.contents;
    if (raw && String(raw).trim().charAt(0) === '{') body = JSON.parse(raw) || {};
  } catch (ignore) {}

  function pick(k) { return (p[k] != null && p[k] !== '') ? p[k] : body[k]; }
  var tranid = pick('tranid') || pick('orderid') || pick('order_id') || pick('systranid') || '';

  // Состав заказа: payment.products (у Тильды — JSON-строка в form-поле или объект в теле),
  // либо products на верхнем уровне.
  var pay = pick('payment');
  if (typeof pay === 'string') { try { pay = JSON.parse(pay); } catch (ignore) { pay = null; } }
  var products = (pay && pay.products) || body.products || p.products || null;
  if (typeof products === 'string') { try { products = JSON.parse(products); } catch (ignore) { products = null; } }

  var items = [];
  if (products && products.length) {
    products.forEach(function (pr) {
      items.push({
        name: pr.name || pr.title || '',
        externalid: pr.externalid || pr.externalId || pr.sku,
        sku: pr.sku,
        quantity: Number(pr.quantity || pr.amount || 1) || 1
      });
    });
  }
  return { tranid: String(tranid), items: items };
}

// Сырое тело/поля вебхука — для журнала, когда заказ не распознан (обрезаем: там ПД клиента).
function rawOrderPayload_(e) {
  var out = '';
  try { out = (e && e.postData && e.postData.contents) || ''; } catch (ignore) {}
  if (!out) { try { out = JSON.stringify((e && e.parameter) || {}); } catch (ignore) { out = '?'; } }
  return String(out).slice(0, 900);
}

// ─── Идемпотентность обработанных заказов ─────────────────────────────────────
function isProcessed_(tranid) { return !!prop_('order_' + tranid); }
function markProcessed_(tranid) { props_().setProperty('order_' + tranid, String(new Date())); }

// ─── Диагностика (doGet, гейт по секрету; после разбора удалить) ───────────────
function doGet(e) {
  var p = (e && e.parameter) || {};
  if (p.secret !== DIAG_SECRET_) return jsonOut_({ ok: false, error: 'forbidden' });
  try {
    switch (p.action) {
      case 'ping': return jsonOut_({ ok: true, ts: String(new Date()) });
      // Разовая установка доступов в Script Properties (значения приходят параметрами).
      case 'setup': {
        var keys = ['PARTNER_TOKEN', 'USER_TOKEN', 'COMPANY_ID', 'WRITEOFF_MASTER_ID', 'TILDA_CML_URL', 'TILDA_CML_LOGIN', 'TILDA_CML_PASS', 'TILDA_PRICE_ID', 'CONTROL_SHEET_ID', 'STORE_STORAGE_ID', 'LAST_SYNC_TS'];
        var set = [];
        keys.forEach(function (k) { if (p[k] != null && p[k] !== '') { props_().setProperty(k, String(p[k])); set.push(k); } });
        return jsonOut_({ ok: true, set: set });
      }
      case 'config': return jsonOut_({ ok: true, hasPartner: !!prop_('PARTNER_TOKEN'), hasUser: !!prop_('USER_TOKEN'), companyId: prop_('COMPANY_ID'), storeStorageId: prop_('STORE_STORAGE_ID'), hasTilda: !!prop_('TILDA_CML_URL') });
      // Удаление складского документа по id (для чистки тестовых операций). Пробуем 2 варианта пути.
      case 'delDoc': {
        var r1 = ycDelete_('/storage_operations/operation/' + companyId_() + '/' + p.doc);
        if (r1.code >= 200 && r1.code < 300) return jsonOut_({ ok: true, via: 'operation', result: r1 });
        var r2 = ycDelete_('/storage_operations/documents/' + companyId_() + '/' + p.doc);
        return jsonOut_({ ok: (r2.code >= 200 && r2.code < 300), via: 'documents', tried_operation: r1, result: r2 });
      }
      // Последние строки журнала (только чтение) — быстрая проверка прогонов и заказов.
      case 'lastLog': {
        var shL = statusSheet_(), n = Number(p.n || 15), valsL = shL.getDataRange().getValues();
        var head = valsL[0], rowsL = valsL.slice(1).slice(-n).map(function (r) {
          return { дата: String(r[0]), операция: r[1], статус: r[2], детали: String(r[3] || '').slice(0, 300), длительность: r[4] };
        });
        return jsonOut_({ ok: true, всегоСтрок: valsL.length - 1, колонки: head, строки: rowsL });
      }
      // Чистка следов тестов: ключи идемпотентности и строки журнала с тестовыми маркерами.
      // Правило Ирины: после тестов история должна быть чистой. Удалить вместе с остальным люком.
      case 'cleanupTests': {
        var MARK = /TEST|PROBE|PROD-|CHECK/i;
        var allProps = props_().getProperties(), delKeys = [];
        Object.keys(allProps).forEach(function (k) {
          if (k.indexOf('order_') === 0 && MARK.test(k)) { props_().deleteProperty(k); delKeys.push(k); }
        });
        var shC = statusSheet_(), delRows = 0, valsC = shC.getDataRange().getValues();
        for (var rc = valsC.length - 1; rc >= 1; rc--) {
          if (MARK.test(String(valsC[rc][3] || '') + ' ' + String(valsC[rc][2] || ''))) { shC.deleteRow(rc + 1); delRows++; }
        }
        return jsonOut_({ ok: true, deletedKeys: delKeys, deletedRows: delRows });
      }
      case 'storages': return jsonOut_({ ok: true, data: ycGet_('/storages/' + companyId_()).data });
      case 'storeStorageId': return jsonOut_({ ok: true, storeStorageId: resolveStoreStorageId_() });
      // Без параметров — как раньше (первые 20). Фильтры для диагностики:
      // minAmount — только с остатком >= N; minPrice — только с ценой >= N; sort=price — по возрастанию цены; limit — сколько отдать.
      case 'goods': {
        var g = fetchStoreGoods_();
        var minAmt = Number(p.minAmount || 0), minPrice = Number(p.minPrice || 0), lim = Number(p.limit || 20);
        var list = g.filter(function (x) { return x.amount >= minAmt && x.price >= minPrice; });
        if (p.sort === 'price') list.sort(function (a, b) { return a.price - b.price; });
        return jsonOut_({ ok: true, count: g.length, matched: list.length, sample: list.slice(0, lim) });
      }
      // Точечный тест обмена: заливает в Тильду ТОЛЬКО указанные good_id (через запятую). Для контроля «обновляет, не двоит».
      case 'testFeed': { var ids = String(p.goods || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); var gs = fetchGoodsByIds_(ids); var r = gs.length ? pushFeed_(gs) : 'нет товаров'; return jsonOut_({ ok: true, pushed: gs.length, skipped: gs._skipped || [], result: r }); }
      // Показать сформированный XML без заливки (для проверки формата).
      case 'previewFeed': { var pi = String(p.goods || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); var pg = fetchGoodsByIds_(pi); return jsonOut_({ ok: true, importXml: buildImportXml_(pg), offersXml: buildOffersXml_(pg) }); }
      // Наполнить master-список good_id (частями, чтобы не упереться в длину URL).
      case 'seedMaster': { var sm = String(p.ids || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean); addMasterIds_(sm); return jsonOut_({ ok: true, added: sm.length, total: masterIds_().length }); }
      case 'master': return jsonOut_({ ok: true, masterCount: masterIds_().length, lastSync: prop_('LAST_SYNC_TS') });
      // Создать таблицу-журнал и запомнить её id.
      case 'createControl': { var cs = SpreadsheetApp.create('tilda-yclients — журнал интеграции'); props_().setProperty('CONTROL_SHEET_ID', cs.getId()); statusSheet_(); return jsonOut_({ ok: true, id: cs.getId(), url: cs.getUrl() }); }
      case 'installTriggers': return jsonOut_({ ok: true, triggers: installTriggers_() });
      case 'changedNew': { var cn = changedGoodIdsNew_(); return jsonOut_({ ok: true, count: cn.ids.length, maxId: cn.maxId, lastTxId: prop_('LAST_TX_ID') }); }
      case 'primeTx': { var pt = changedGoodIdsNew_(); props_().setProperty('LAST_TX_ID', String(pt.maxId)); return jsonOut_({ ok: true, primedTo: pt.maxId }); }
      case 'runInc': syncStockToTilda_(); return jsonOut_({ ok: true, lastSync: prop_('LAST_SYNC_TS') });
      case 'runFull': syncFullToTilda_(); return jsonOut_({ ok: true, lastSync: prop_('LAST_SYNC_TS') });
      // Боевой тест списания: спишет 1 шт товара good_id и НЕ должен создать финоперацию.
      case 'testWriteOff': return jsonOut_({ ok: true, result: createOnlineSale_([{ good_id: p.good_id, amount: 1 }], 'ТЕСТ списания (проверка 0 к оплате)') });
      // Гибкий тест: любой type_id (1=продажа, 4=списание) + unit_type, всё по нулям.
      case 'testOp': { var mo = Number(requireProp_('WRITEOFF_MASTER_ID')); var tp = Number(p.type_id || 1), ut = Number(p.unit_type || 1);
        return jsonOut_({ ok: true, result: ycPost_('/storage_operations/operation/' + companyId_(), { type_id: tp, storage_id: Number(resolveStoreStorageId_()), master_id: mo, create_date: formatDate_(new Date()), comment: 'ТЕСТ операция type=' + tp + ' 0 к оплате', goods_transactions: [{ good_id: Number(p.good_id), amount: 1, cost_per_unit: 0, discount: 0, cost: 0, operation_unit_type: ut, master_id: mo }] }) }); }
      // Обратный приход (вернуть 1 шт после теста).
      case 'testReturn': { var mr = Number(requireProp_('WRITEOFF_MASTER_ID')); return jsonOut_({ ok: true, result: ycPost_('/storage_operations/operation/' + companyId_(), { type_id: 3, storage_id: Number(resolveStoreStorageId_()), master_id: mr, create_date: formatDate_(new Date()), comment: 'ТЕСТ возврат', goods_transactions: [{ good_id: Number(p.good_id), amount: 1, cost_per_unit: 0, discount: 0, cost: 0, operation_unit_type: 1, master_id: mr }] }) }); }
      default: return jsonOut_({ ok: false, error: 'unknown action' });
    }
  } catch (err) { return jsonOut_({ ok: false, error: String(err && err.message || err) }); }
}

// ─── Почта об ошибках + лист «Статус автоматики» (копия паттерна финансовой интеграции) ──
function reportError_(where, e) {
  var msg = String((e && e.message) || e);
  sendErrorEmail_('[Тильда↔YClients] Ошибка: ' + where, where + '\n\n' + msg + '\n\n' + (e && e.stack ? e.stack : ''));
  logStatus_(where, 'ОШИБКА', msg, new Date());
}

function sendErrorEmail_(subject, body) {
  try { MailApp.sendEmail(OWNER_EMAIL_, subject, body); }
  catch (e) { Logger.log('Не удалось отправить email: ' + e.message); }
}

function logStatus_(operation, status, details, started) {
  try {
    var sh = statusSheet_();
    sh.appendRow([new Date(), operation, status, details || '', started ? (new Date() - started) + ' мс' : '']);
  } catch (e) { Logger.log('logStatus_ error: ' + e.message); }
}

function logUnmatched_(kind, names) {
  try {
    var ss = SpreadsheetApp.openById(requireProp_('CONTROL_SHEET_ID'));
    var sh = ss.getSheetByName('Несопоставленные') || ss.insertSheet('Несопоставленные');
    if (sh.getLastRow() === 0) sh.appendRow(['Дата', 'Тип', 'Что']);
    names.forEach(function (n) { sh.appendRow([new Date(), kind, n]); });
  } catch (e) { Logger.log('logUnmatched_ error: ' + e.message); }
}

function statusSheet_() {
  var ss = SpreadsheetApp.openById(requireProp_('CONTROL_SHEET_ID'));
  var sh = ss.getSheetByName('Статус автоматики');
  if (!sh) { sh = ss.insertSheet('Статус автоматики'); sh.appendRow(['Дата', 'Операция', 'Статус', 'Детали', 'Длительность']); }
  return sh;
}

// ─── Чистка журнала: удаляем строки старше месяца (раз в месяц, триггер) ───────
// Тот же подход, что в планировщике: листы пишутся хронологически → режем сверху до первой
// свежей строки. Просьба Ирины: журнал не должен раздуваться со временем.
var LOG_RETENTION_MONTHS_ = 1;
function purgeOldLogs_() {
  var ss = SpreadsheetApp.openById(requireProp_('CONTROL_SHEET_ID'));
  var now = new Date();
  var cutoff = new Date(now.getFullYear(), now.getMonth() - LOG_RETENTION_MONTHS_, now.getDate());
  var total = 0;
  ['Статус автоматики', 'Несопоставленные'].forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) return;
    var last = sh.getLastRow();
    if (last < 2) return;
    var dates = sh.getRange(2, 1, last - 1, 1).getValues();
    var del = 0;
    for (var i = 0; i < dates.length; i++) {
      var d = dates[i][0];
      var rd = (d instanceof Date) ? d : new Date(String(d).replace('T', ' '));
      if (isNaN(rd.getTime())) { del++; continue; }   // битая дата — под чистку
      if (rd >= cutoff) break;                         // дошли до свежих — дальше всё свежее
      del++;
    }
    if (del > 0) { sh.deleteRows(2, del); total += del; }
  });
  // старые ключи идемпотентности заказов тоже подчистим (свойства order_*), чтобы не копились
  purgeOldOrderKeys_(cutoff);
  logStatus_('Очистка журнала (раз в месяц)', 'OK', 'удалено строк старше ' + LOG_RETENTION_MONTHS_ + ' мес.: ' + total, now);
  return total;
}

function purgeOldOrderKeys_(cutoff) {
  var all = props_().getProperties(), toDel = [];
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('order_') !== 0) return;
    var d = new Date(String(all[k]).replace('T', ' '));
    if (isNaN(d.getTime()) || d < cutoff) toDel.push(k);
  });
  toDel.forEach(function (k) { props_().deleteProperty(k); });
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function formatDate_(d) {
  return Utilities.formatDate(d, 'Europe/Moscow', 'yyyy-MM-dd HH:mm:ss');
}
function xmlEsc_(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Разовое согласие владельца на скоупы (Ирина запускает ▶️ authorize в редакторе) ──
function authorize() {
  // Скоупы определяются статически по всему коду проекта — запуск любой функции, требующей
  // авторизации, вызывает согласие сразу на ВСЕ нужные скоупы (UrlFetch/Properties/Spreadsheet/Mail/Script).
  PropertiesService.getScriptProperties().getProperty('COMPANY_ID');
  UrlFetchApp.getRequest('https://api.yclients.com/api/v1/', {});
  MailApp.getRemainingDailyQuota();
  ScriptApp.getProjectTriggers();
  return 'authorized';
}

// ─── Установка триггера синхронизации (запустить один раз после настройки) ─────
function installTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var f = t.getHandlerFunction();
    if (['syncStockToTilda_', 'syncFullToTilda_', 'purgeOldLogs_'].indexOf(f) !== -1) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncStockToTilda_').timeBased().everyMinutes(SYNC_INTERVAL_MIN_).create();   // инкремент 5 мин
  ScriptApp.newTrigger('syncFullToTilda_').timeBased().everyDays(1).atHour(4).create();               // полная сверка ночью
  ScriptApp.newTrigger('purgeOldLogs_').timeBased().onMonthDay(1).atHour(5).create();                 // чистка журнала раз в месяц
  return ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
}

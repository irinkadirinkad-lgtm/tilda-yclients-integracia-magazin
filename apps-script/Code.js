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
var OWNER_EMAIL_ = 'irinkadirinkad@gmail.com';   // он же — единственный, кому доступен служебный doGet
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
  var resp = ycFetch_(YC_BASE_ + path + qs, { method: 'get', headers: ycHeaders_(), muteHttpExceptions: true }, true);
  return ycParse_(resp, 'GET ' + path);
}

function ycPost_(path, payload) {
  var resp = ycFetch_(YC_BASE_ + path, {
    method: 'post', headers: ycHeaders_(), payload: JSON.stringify(payload), muteHttpExceptions: true
  }, false);
  return ycParse_(resp, 'POST ' + path);
}

// Единая точка обращения к YClients с вежливым повтором.
// 429 («слишком часто») — повторяем ВСЕГДА: запрос заведомо не обработан, задвоить нечего.
// 5xx (сбой на их стороне) — повторяем ТОЛЬКО для чтения (idempotent=true): повторить POST
// создания операции опасно — она могла пройти, а ответ потеряться, и получится вторая продажа.
// Ждём 3 → 9 → 20 секунд; дольше нельзя — у триггера Apps Script всего 6 минут на прогон.
// Ограничитель СКОРОСТИ (не суточного объёма!). Лимит YClients — 5 запросов в СЕКУНДУ, и суточный
// запас от него не спасает: опасны короткие всплески. Например приход накладной на 60 позиций
// заставляет пятиминутку запросить 60 карточек подряд — без паузы это 8–10 запросов в секунду,
// то есть выше потолка. Держим не чаще 4 запросов в секунду (пауза 250 мс между обращениями).
var YC_MIN_GAP_MS_ = 250;
var _ycLastCallAt_ = 0;
function ycPace_() {
  var wait = YC_MIN_GAP_MS_ - (new Date().getTime() - _ycLastCallAt_);
  if (wait > 0) Utilities.sleep(wait);
  _ycLastCallAt_ = new Date().getTime();
}

function ycFetch_(url, opts, idempotent) {
  var WAITS = [3000, 9000, 20000], resp = null;
  for (var i = 0; i <= WAITS.length; i++) {
    ycPace_();
    resp = UrlFetchApp.fetch(url, opts);
    var code = resp.getResponseCode();
    var retryable = (code === 429) || (idempotent && code >= 500 && code < 600);
    if (!retryable || i === WAITS.length) return resp;
    Utilities.sleep(WAITS[i]);
  }
  return resp;
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
// Выбирает ДЕШЁВЫЙ способ прочитать нужные товары.
// Поштучно (`/goods/{id}`) — это 1 запрос на товар: хорошо для 1–20 позиций (обычная продажа).
// Но ПРИХОД накладной у Ирины бывает на 50–150 позиций (реальные цифры, 26.07) — тогда поштучно
// это 150 запросов подряд, всплеск и минуты работы. Постраничное чтение всего каталога стоит
// ВСЕГО ~8 запросов независимо от количества, поэтому на больших приходах берём его.
var BULK_READ_FROM_ = 20;
function fetchGoodsSmart_(ids) {
  if (ids.length <= BULK_READ_FROM_) return fetchGoodsByIds_(ids);
  var want = {}; ids.forEach(function (x) { want[String(x)] = 1; });
  var out = fetchStoreGoods_().filter(function (g) { return want[String(g.good_id)]; });
  out._skipped = [];
  return out;
}

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
  var text = comment || "Заказ из интернет-магазина El’Naturel Shop";   // текст подписи выбрала Ирина 25.07

  // ⚠️ ПОРЯДОК ВАЖЕН — он выбран ради надёжности (разобрано на боевом 25.07):
  // ШАГ 1. Операция создаётся ОДНИМ запросом (документ + все позиции). Это главное: списание
  //        атомарно, «половины» быть не может, лишних пустых документов не появляется.
  // ШАГ 2. Подписи дописываем отдельно (PUT по позиции и по документу). YClients теряет
  //        комментарий позиции при создании, но обновлением он ставится. Если этот шаг
  //        сорвётся — остаток УЖЕ списан правильно, не хватает только подписи, и она
  //        добирается очередью повторов. То есть сбой подписи не может испортить склад.
  var res = ycPost_('/storage_operations/operation/' + companyId_(), {
    type_id: 1,                        // 1 = продажа товара
    storage_id: Number(resolveStoreStorageId_()),
    master_id: master,
    create_date: formatDate_(new Date()),
    comment: text,
    goods_transactions: items.map(function (it) {
      return {
        good_id: Number(it.good_id),
        amount: Number(it.amount),
        cost_per_unit: 0,
        discount: 0,
        cost: 0,
        operation_unit_type: 1,        // 1 = продажа
        master_id: master,
        comment: text                  // при создании теряется, но пусть будет
      };
    })
  });

  var data = (res && res.data) || {};
  var docId = data.document_id || (data.document || {}).id || null;
  var txs = data.goods_transactions || [];
  if (!docId) throw new Error('YClients не вернул id документа: ' + JSON.stringify(res).slice(0, 300));

  // ШАГ 2: подпись каждой позиции (её видно в СПИСКЕ операций).
  txs.forEach(function (t) {
    try { setTxComment_(docId, t, text); }
    catch (e) { queueRetry_(docId, t.id, t.good_id, Math.abs(Number(t.amount)) || 1, text, String(e && e.message || e)); }
  });
  // Подпись документа (её видно в КАРТОЧКЕ).
  try { setDocumentComment_(docId, text); }
  catch (e) {
    logStatus_('Заказ с сайта', 'ВНИМАНИЕ', 'подпись документа не проставлена: ' +
      String(e && e.message || e).slice(0, 150), new Date());
  }
  return { document_id: docId, позиций: txs.length };
}

// Дописывает комментарий ПОЗИЦИИ. PUT требует ПОЛНОЕ тело позиции — иначе 400 «Не указан
// идентификатор товара». Значения передаём те же, что уже стоят, меняем только comment:
// проверено, что количество и остаток при этом не меняются.
function setTxComment_(docId, t, text) {
  var body = {
    document_id: Number(docId),
    good_id: Number(t.good_id),
    amount: Math.abs(Number(t.amount)) || 1,
    cost_per_unit: Number(t.cost_per_unit) || 0,
    discount: Number(t.discount) || 0,
    cost: Number(t.cost) || 0,
    operation_unit_type: Number(t.operation_unit_type) || 1,
    master_id: Number(t.master_id) || Number(requireProp_('WRITEOFF_MASTER_ID')),
    comment: text
  };
  var resp = ycFetch_(YC_BASE_ + '/storage_operations/goods_transactions/' + companyId_() + '/' + t.id,
    { method: 'put', headers: ycHeaders_(), payload: JSON.stringify(body), muteHttpExceptions: true }, true);
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    throw new Error('PUT подписи позиции ' + t.id + ' → HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
  }
  return true;
}

// Проставляет комментарий существующему складскому документу (см. пояснение выше).
function setDocumentComment_(docId, text) {
  var path = '/storage_operations/documents/' + companyId_() + '/' + docId;
  var cur = ycGet_(path), d = (cur && cur.data) || {};
  var resp = ycFetch_(YC_BASE_ + path, {
    method: 'put', headers: ycHeaders_(), muteHttpExceptions: true,
    payload: JSON.stringify({
      comment: text,
      type_id: d.type_id,
      storage_id: d.storage_id,
      create_date: d.create_date        // полное «ГГГГ-ММ-ДД ЧЧ:ММ:СС», иначе 400
    })
  }, true);
  if (resp.getResponseCode() < 200 || resp.getResponseCode() >= 300) {
    throw new Error('PUT комментария → HTTP ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 200));
  }
  return true;
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
// Замок разводит НАШИ прогоны, но коннектор Тильды после обмена ещё какое-то время занят.
// Выдерживаем паузу от последней заливки ПРОШЛОГО прогона — иначе новый обмен получит «busy».
// Вызывать один раз в начале прогона, а НЕ внутри pushCommerceML_: партии одного прогона
// расходятся своей паузой в 8 с, и 45 с между ними были бы лишней тратой времени.
var CML_COOLDOWN_MS_ = 45000;
function cmlCooldown_() {
  var lastPush = Number(prop_('CML_LAST_PUSH_TS') || 0);
  if (!lastPush) return;
  var waitMs = CML_COOLDOWN_MS_ - (Date.now() - lastPush);
  if (waitMs > 0) Utilities.sleep(Math.min(waitMs, CML_COOLDOWN_MS_));
}

function pushCommerceML_(files) {
  var base = requireProp_('TILDA_CML_URL');
  var auth = 'Basic ' + Utilities.base64Encode(requireProp_('TILDA_CML_LOGIN') + ':' + requireProp_('TILDA_CML_PASS'));
  // 1. checkauth → success\n{cookieName}\n{cookieValue}
  // ⚠️ У Тильды есть ограничение частоты («Many requests. Please try again later»).
  // Прежняя версия сверки тянула товары по одному и потому невольно делала паузы; когда чтение
  // ускорили, заливки пошли подряд и упёрлись в лимит (25.07). Поэтому — повтор с ожиданием.
  var r = null, lines = null;
  for (var att = 1; att <= 4; att++) {
    r = UrlFetchApp.fetch(base + '?type=catalog&mode=checkauth', { headers: { Authorization: auth }, muteHttpExceptions: true });
    lines = r.getContentText().split(/\r?\n/);
    if (lines[0] === 'success') break;
    if (att === 4 || r.getContentText().toLowerCase().indexOf('many request') === -1) {
      throw new Error('Tilda checkauth: ' + r.getContentText().slice(0, 200));
    }
    Utilities.sleep(att * 10000);            // 10 с, 20 с, 30 с
  }
  var cookie = lines[1] + '=' + lines[2];
  var setc = r.getAllHeaders()['Set-Cookie'];
  if (setc) (Array.isArray(setc) ? setc : [setc]).forEach(function (c) { cookie += '; ' + String(c).split(';')[0]; });
  var hdr = { Authorization: auth, Cookie: cookie };
  // 2. init → zip=no\nfile_limit=NNN
  UrlFetchApp.fetch(base + '?type=catalog&mode=init', { headers: hdr, muteHttpExceptions: true });
  // 3-4. file + import для каждого файла
  var out = [];
  files.forEach(function (f) {
    // Коннектор у Тильды ОДИН на проект: пока он дожёвывает прошлый файл, новый не принимает
    // («Connector is busy. Please wait.»). Это не поломка, а очередь — ждём и повторяем.
    var fr = null, ftxt = '';
    for (var a = 1; a <= 4; a++) {
      fr = UrlFetchApp.fetch(base + '?type=catalog&mode=file&filename=' + encodeURIComponent(f.name),
        { method: 'post', headers: hdr, contentType: 'application/xml; charset=UTF-8', payload: f.xml, muteHttpExceptions: true });
      ftxt = fr.getContentText();
      if (ftxt.indexOf('success') !== -1) break;
      if (a === 4 || ftxt.toLowerCase().indexOf('busy') === -1) {
        throw new Error('Tilda file ' + f.name + ': ' + ftxt.slice(0, 200));
      }
      Utilities.sleep(a * 10000);              // 10 с, 20 с, 30 с
    }
    // Разбор файла на стороне Тильды. Ждём до 2 минут (было 45 с — на больших партиях не хватало).
    var res = 'progress';
    for (var i = 0; i < 60 && res.indexOf('progress') === 0; i++) {
      var ir = UrlFetchApp.fetch(base + '?type=catalog&mode=import&filename=' + encodeURIComponent(f.name), { headers: hdr, muteHttpExceptions: true });
      res = ir.getContentText();
      if (res.indexOf('progress') === 0) Utilities.sleep(2000);
    }
    // ⚠️ «progress» по истечении ожидания — НЕ ошибка: Тильда продолжает разбирать файл сама,
    // данные дойдут. Раньше на этом падали и слали письмо на ровном месте. Ошибкой считаем
    // только явный отказ. Остаток мы шлём АБСОЛЮТНЫМ числом, поэтому неподтверждённая заливка
    // в худшем случае выправится следующим прогоном — расхождение накопиться не может.
    if (res.indexOf('success') !== 0 && res.indexOf('progress') !== 0) {
      throw new Error('Tilda import ' + f.name + ': ' + res.slice(0, 200));
    }
    out.push(f.name + ': ' + res.split(/\r?\n/)[0]);
  });
  props_().setProperty('CML_LAST_PUSH_TS', String(Date.now()));
  return out.join(' | ');
}

// ─── ИНКРЕМЕНТ (триггер ~5 мин): шлём в Тильду только то, что изменилось ────────
// Лёгкий цикл: спрашиваем YClients, какие товары двигались с прошлого раза (складские
// транзакции changed_after), шлём в Тильду только их. Нет изменений → ничего не шлём.
function syncStockToTilda_() {
  var started = new Date();
  // Не даём прогонам налезать друг на друга: раз в час пятиминутка совпадает с полной сверкой,
  // и тогда к YClients и к Тильде идут ДВА потока запросов одновременно (всплеск + две
  // параллельные сессии CommerceML). Ждём до 2 минут; не дождались — просто пропускаем,
  // через 5 минут прогон повторится сам.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(120000)) return;
  try { retryPending_(); } catch (e) { reportError_('Очередь повторов', e); }   // сначала добираем недолитое
  try {
    var d = changedGoodIdsNew_();                         // {ids, maxId} — новые складские операции по номеру
    if (d.ids.length) {
      addMasterIds_(d.ids);                               // новые товары — в master-список
      var goods = fetchGoodsSmart_(d.ids);                // поштучно или каталогом — что дешевле
      if (goods.length) cmlCooldown_();                   // дать коннектору Тильды отдышаться
      var res = goods.length ? pushFeedBatched_(goods) : 'нет карточек';
      // Запас прочности: после любого движения по складу заставляем ближайшую полную сверку
      // отправить всё целиком, не полагаясь на сравнение. Строго говоря, сравнение и так
      // заметило бы разницу (оно идёт по свежим цифрам YClients), но движения — событие редкое,
      // а лишняя контрольная отправка после продажи стоит дёшево.
      if (goods.length) props_().deleteProperty('FULL_FEED_HASH');
      logStatus_('Обновление сайта', 'OK', 'изменённых: ' + goods.length + ' | ' + res, started);
    } else {
      // «Изменений нет» в журнал НЕ пишем: это 288 пустых строк в сутки, журнал становится
      // нечитаемым (решение 25.07). Вместо этого — отметка «жив» раз в сутки, чтобы было видно,
      // что автоматика работает, даже когда продаж не было. Точное время последнего прогона
      // всегда есть в LAST_SYNC_TS (?action=master).
      var today = formatDate_(started).slice(0, 10);
      if (prop_('HEARTBEAT_DAY') !== today) {
        props_().setProperty('HEARTBEAT_DAY', today);
        logStatus_('Обновление сайта', 'OK', 'автоматика работает, изменений нет (отметка раз в сутки)', started);
      }
    }
    props_().setProperty('LAST_SYNC_TS', formatDate_(started));
  } catch (e) {
    reportError_('Обновление сайта (каждые 5 мин)', e, started);
  } finally {
    lock.releaseLock();
  }
}

// Новые складские операции с прошлого раза — по НОМЕРУ операции (id растёт; changed_after у YClients
// не работает). Окно — вчера+сегодня (перехлёст на полночь). Возвращает {ids: [good_id...], maxId}.
function changedGoodIdsNew_() {
  var storageId = String(resolveStoreStorageId_());
  var now = new Date();
  // Окно — 3 суток: этого хватает, чтобы заметить удаление вчерашнего заказа. Более старое
  // выправит ночная полная сверка.
  var d1 = formatDate_(new Date(now.getTime() - 3 * 24 * 3600 * 1000)).slice(0, 10);
  var d2 = formatDate_(now).slice(0, 10);
  var rows = [], page = 1;
  while (page <= 20) {
    var res = ycGet_('/storages/transactions/' + companyId_(), { start_date: d1, end_date: d2, count: 1000, page: page });
    var r = (res && res.data) || [];
    if (!r.length) break;
    rows = rows.concat(r);
    if (r.length < 1000) break;
    page++;
  }

  // ⚠️ ПОЧЕМУ СРАВНИВАЕМ СПИСКИ, А НЕ ТОЛЬКО НОМЕРА (найдено 25.07 по наблюдению Ирины):
  // раньше искали только НОВЫЕ операции (id > LAST_TX_ID) — и не замечали УДАЛЕНИЕ: удалённая
  // операция просто исчезает, нового номера не появляется. Из-за этого после отмены заказа
  // остаток в YClients возвращался, а на сайте оставался заниженным до ночной сверки.
  // Теперь помним прошлый список «номер операции → товар» и берём и появившиеся, и исчезнувшие.
  // Дополнительных запросов это НЕ требует: список уже пришёл тем же единственным запросом.
  var cur = {}, set = {};
  rows.forEach(function (t) {
    var id = Number(t.id) || 0, g = t.good || {};
    if (!id || !g.id) return;
    if (t.storage_id != null && String(t.storage_id) !== storageId) return;
    cur[id] = g.id;
  });

  var prev = parseSeenTx_(prop_('TX_SEEN'));
  var first = !prop_('TX_SEEN');
  // ⚠️ ВЫПАДЕНИЕ ИЗ ОКНА — НЕ УДАЛЕНИЕ (найдено 29.07 по письмам об ошибках). Окно скользит
  // по ДАТАМ, поэтому ровно в полночь самый старый день уходит из выборки и все его операции
  // выглядят «исчезнувшими». Каждую ночь из-за этого шла лишняя заливка — и стыкалась с часовой
  // сверкой в 00:01, а коннектор Тильды не выносит два обмена подряд («Connector is busy»).
  // В прогон, когда граница окна сдвинулась, пропажи не считаем удалениями: отличить настоящее
  // удаление от выпадения по дате в этот момент нечем. Сравнивать по «самому старому номеру в
  // окне» нельзя — тогда удаление самой старой операции не замечалось бы НИКОГДА.
  // Пропущенное в этот единственный прогон подхватит полная сверка (она ежечасная).
  var winStart = prop_('TX_WIN_START');
  var winMoved = winStart !== d1;
  if (winMoved) props_().setProperty('TX_WIN_START', d1);
  if (!first) {
    Object.keys(cur).forEach(function (id) { if (prev[id] === undefined) set[cur[id]] = 1; });   // появились
    if (!winMoved) {
      Object.keys(prev).forEach(function (id) { if (cur[id] === undefined) set[prev[id]] = 1; }); // удалили
    }
  }
  props_().setProperty('TX_SEEN', serializeSeenTx_(cur));
  return { ids: Object.keys(set), первыйПрогон: first, операцийВОкне: Object.keys(cur).length,
           границаОкнаСдвинулась: winMoved };
}

// Компактное хранение «номер операции:товар» через запятую. Ограничиваем длину: у Script
// Property лимит ~9 КБ, при переполнении отбрасываем самые старые номера (их подхватит
// ночная полная сверка).
function serializeSeenTx_(map) {
  var ids = Object.keys(map).sort(function (a, b) { return Number(b) - Number(a); });   // новые вперёд
  var parts = [], len = 0;
  for (var i = 0; i < ids.length; i++) {
    var piece = ids[i] + ':' + map[ids[i]];
    if (len + piece.length + 1 > 8000) break;
    parts.push(piece); len += piece.length + 1;
  }
  return parts.join(',');
}

function parseSeenTx_(str) {
  var out = {};
  String(str || '').split(',').forEach(function (pair) {
    if (!pair) return;
    var i = pair.indexOf(':');
    if (i > 0) out[pair.slice(0, i)] = pair.slice(i + 1);
  });
  return out;
}

// ─── ПОЛНАЯ СВЕРКА (триггер раз в сутки, ночь): весь master-список остатков+цен → Тильда ──
function syncFullToTilda_() {
  var started = new Date();
  var lock = LockService.getScriptLock();          // не пересекаться с пятиминуткой (см. её комментарий)
  if (!lock.tryLock(120000)) { logStatus_('Полная сверка сайта', 'ВНИМАНИЕ', 'пропущена: занят другой прогон', started); return; }
  try {
    // ДЕШЁВОЕ чтение: постраничный /goods (~7 запросов на 700 товаров) вместо 500 одиночных
    // запросов, как было раньше (из-за них сверка стоила дорого и жила только ночью).
    // Набор товаров тот же — master-список; отправляем партиями, чтобы XML не был огромным.
    var ids = masterIds_();
    if (!ids.length) { logStatus_('Полная сверка сайта', 'OK', 'master пуст', started); return; }
    var want = {}; ids.forEach(function (x) { want[String(x)] = 1; });

    var all = fetchStoreGoods_();
    var goods = all.filter(function (g) { return want[String(g.good_id)]; });

    // Отпечаток того, что реально уезжает на сайт: товар + остаток + цена. Названия и артикулы
    // в отпечаток НЕ входят — мы их не синхронизируем, Тильда их игнорирует, и их правки не
    // должны гонять заливку впустую.
    var fp = feedFingerprint_(goods);
    var today = formatDate_(started).slice(0, 10);
    var forced = prop_('FULL_FORCE_DAY') !== today;   // раз в сутки шлём принудительно
    var same = !forced && prop_('FULL_FEED_HASH') === fp;

    var pushed = 0, batches = 0;
    if (same) {
      // Цифры совпали с прошлой отправкой — на сайте уже ровно это. Идти в Тильду незачем:
      // именно эти холостые обмены и создавали столкновения с пятиминуткой.
      props_().setProperty('LAST_SYNC_TS', formatDate_(started));
      logStatus_('Полная сверка сайта', 'OK', 'изменений нет, на сайт не отправляли (проверено товаров: ' +
        goods.length + ' из ' + ids.length + ')', started);
      return { изменений: 0, проверено: goods.length, вMaster: ids.length, вКаталоге: all.length, отправляли: false };
    }

    cmlCooldown_();                             // дать коннектору Тильды отдышаться после прошлого прогона
    pushFeedBatched_(goods);                    // партии по 250 с паузами (см. pushFeedBatched_)
    pushed = goods.length; batches = Math.ceil(goods.length / FEED_BATCH_);
    // ⚠️ Отпечаток сохраняем ТОЛЬКО после успешной отправки. Сохранить его раньше — значит при
    // сбое заливки навсегда решить, что «на сайте уже всё правильно», и больше не отправлять.
    props_().setProperty('FULL_FEED_HASH', fp);
    if (forced) props_().setProperty('FULL_FORCE_DAY', today);
    props_().setProperty('LAST_SYNC_TS', formatDate_(started));
    logStatus_('Полная сверка сайта', 'OK', 'отправлено товаров: ' + pushed + ' из ' + ids.length +
      ' (в каталоге ' + all.length + '), партий: ' + batches + (forced ? ' | суточная контрольная отправка' : ''), started);
    return { отправлено: pushed, вMaster: ids.length, вКаталоге: all.length, партий: batches,
             суточнаяКонтрольная: forced, отправляли: true };
  } catch (e) {
    reportError_('Полная сверка сайта', e, started);
    throw e;
  } finally {
    lock.releaseLock();
  }
}

// Отпечаток фида: товар + остаток + цена, отсортировано по товару, свёрнуто в короткий хеш.
// Сортировка обязательна — иначе порядок страниц YClients менял бы отпечаток на пустом месте.
function feedFingerprint_(goods) {
  var parts = goods.map(function (g) {
    return String(g.good_id) + ':' + Number(g.amount || 0) + ':' + Number(g.price || 0);
  }).sort();
  var raw = parts.join(',');
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw, Utilities.Charset.UTF_8)
    .map(function (b) { return ('0' + (b & 0xFF).toString(16)).slice(-2); }).join('') + '/' + parts.length;
}

// master-список good_id (что синхроним): хранится строкой в Script Property.
function masterIds_() { var s = prop_('MASTER_GOOD_IDS') || ''; return s ? s.split(',') : []; }
// Добавляет good_id в master-список (что синхроним дальше).
// Новый товар отдельно НЕ анонсируем: в Тильде включено «создавать новые товары», карточка
// создаётся сама из нашего фида — с названием и ценой из YClients и с проставленным External ID.
// Ирина потом дозаполняет категорию/фото. Письмо об этом — лишний шум (решение Ирины 25.07).
function addMasterIds_(ids) {
  var have = {}; masterIds_().forEach(function (x) { have[x] = 1; });
  var changed = false;
  ids.forEach(function (x) { x = String(x); if (!have[x]) { have[x] = 1; changed = true; } });
  if (changed) props_().setProperty('MASTER_GOOD_IDS', Object.keys(have).join(','));
}

// Заливка партиями: Тильда не любит частые обмены, а огромный XML не любит никто.
// 250 товаров в партии, пауза 8 с между партиями. Используют оба прогона — и пятиминутка
// (большой приход), и полная сверка.
var FEED_BATCH_ = 250;
function pushFeedBatched_(goods) {
  var out = [], batches = 0;
  for (var i = 0; i < goods.length; i += FEED_BATCH_) {
    if (i > 0) Utilities.sleep(8000);
    out.push(pushFeed_(goods.slice(i, i + FEED_BATCH_)));
    batches++;
  }
  return out.join(' | ') + (batches > 1 ? (' | партий: ' + batches) : '');
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
  // ⚠️ КРИТИЧНО И ПЕРВЫМ ДЕЛОМ. При сохранении вебхука Тильда сама шлёт проверочный запрос
  // test=test и ждёт ответ 200 в течение 5 СЕКУНД. Не ответим вовремя — вебхук не активируется
  // и заказы не приходят вообще (на это мы потеряли время 25.07). Поэтому проверку обрабатываем
  // ДО всего остального: ни таблицы, ни почты, ни YClients, и запись счётчика — одним вызовом.
  try {
    var pt = (e && e.parameter) || {};
    var rawT = (e && e.postData && e.postData.contents) || '';
    if (pt.test === 'test' || String(rawT).indexOf('test=test') !== -1) {
      var out = jsonOut_({ ok: true, test: true });      // ответ готовим ДО записи счётчика
      try {
        props_().setProperties({                          // один вызов вместо четырёх
          HITS_TILDA_TEST: String(Number(prop_('HITS_TILDA_TEST') || 0) + 1),
          HITS_TILDA_TEST_LAST: String(new Date())
        });
      } catch (ignore2) {}
      return out;
    }
  } catch (ignore) {}
  bumpHit_('HITS_POST');
  try {
    var order = parseTildaOrder_(e);
    // Не распознали заказ — НЕ молчим: в журнал + письмо, иначе заказ потеряется незаметно.
    if (!order.tranid) {
      var rawNoId = rawOrderPayload_(e);
      // Сначала СПИСОК ПОЛЕЙ (компактно и полностью), потом тело: у Тильды поля могут быть
      // с русскими именами, и по обрезанному телу их не видно (проверено 25.07).
      var infoNoId = 'поля: ' + payloadFields_(e) + ' || тело: ' + rawNoId;
      logStatus_('Заказ с сайта', 'ОШИБКА', 'не найден номер заказа; ' + infoNoId, new Date());
      reportError_('Приём заказа с сайта', new Error('Не найден номер заказа. ' + infoNoId));
      return jsonOut_({ ok: false, error: 'no tranid' });
    }
    // Номер есть, а состав не распознан — сигнал: поля вебхука не те, что мы ждём.
    // Тело запроса пишем в журнал и в письмо — по нему сразу видно реальный формат Тильды.
    // (Фильтра «обычная форма» больше нет: вебхук подключён ТОЛЬКО к корзине, решение Ирины
    // 25.07 — «применить ко всем формам» она не нажимала. Значит всё, что приходит, — заказ.)
    if (!order.items.length) {
      logStatus_('Заказ с сайта', 'ВНИМАНИЕ', '#' + order.tranid + ' без состава; тело: ' + rawOrderPayload_(e), new Date());
      reportError_('Заказ с сайта №' + order.tranid, new Error('Заказ пришёл, но состав не распознан. Тело: ' + rawOrderPayload_(e)));
    }
    if (isProcessed_(order.tranid)) return jsonOut_({ ok: true, dup: true });   // идемпотентность

    // externalid позиции Тильды = '_' + good_id → good_id получаем напрямую, без справочника.
    var items = [], unmatched = [];
    order.items.forEach(function (it) {
      var gid = goodIdFromExternal_(it.externalid || it.sku);
      if (gid) items.push({ good_id: gid, amount: it.quantity });
      else unmatched.push(it);
    });

    // НОМЕР В КОММЕНТАРИИ — сквозная нумерация Ирины, и ВЕДЁМ ЕЁ МЫ (`ORDER_SEQ_NEXT`).
    // Тильда свой «порядковый номер заявки» в вебхук НЕ передаёт: приходит только внутренний
    // payment[orderid] (длинное число), а payment[systranid] всегда 0 — проверено на боевом.
    // Счётчик засеян числом 233 (у Ирины на 25.07 текущий заказ был 232).
    // ⚠️ Если нумерация Ирины и наш счётчик когда-нибудь разойдутся — поправить одним запросом
    // ?action=setup&ORDER_SEQ_NEXT=<нужный номер>. Внутренний id Тильды в комментарий не пишем
    // (решение Ирины — один номер), но кладём в журнал: по нему всегда можно сопоставить заказ.
    var ourNo = null;
    if (items.length) {
      ourNo = nextOrderNo_();
      createOnlineSale_(items, "Заказ из интернет-магазина El’Naturel Shop №" + ourNo);
    }
    markProcessed_(order.tranid);
    if (unmatched.length) {
      logUnmatched_('order_no_match', unmatched.map(function (u) { return (u.name || '') + ' [' + (u.externalid || u.sku || '') + ']'; }));
      reportError_('Заказ с сайта №' + order.tranid, new Error('Не сопоставлены позиции: ' + unmatched.length));
    }
    logStatus_('Заказ с сайта', 'OK', '№' + (ourNo || '—') + ' (Тильда ' + order.tranid + ')' +
      ', списано позиций: ' + items.length, new Date());
    return jsonOut_({ ok: true, orderNo: ourNo, tildaId: order.tranid, written: items.length, unmatched: unmatched.length });
  } catch (err) {
    // Ошибку пишем И в журнал (раньше уходила только письмом — в журнале следа не оставалось).
    logStatus_('Заказ с сайта', 'ОШИБКА', String(err && err.message || err).slice(0, 250) +
      ' | поля вебхука: ' + payloadFields_(e), new Date());
    reportError_('Приём заказа с сайта (doPost)', err);
    return jsonOut_({ ok: false, error: String(err && err.message || err) });
  }
}

// Счётчик обращений к веб-приложению — чтобы понимать, дошёл ли запрос ВООБЩЕ
// (без записи в журнал, чтобы не засорять его чужими/ботовыми запросами).
function bumpHit_(key) {
  try {
    var n = Number(props_().getProperty(key) || 0) + 1;
    props_().setProperty(key, String(n));
    props_().setProperty(key + '_LAST', String(new Date()));
  } catch (ignore) {}
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

  // ⚠️ РЕАЛЬНЫЙ ФОРМАТ ТИЛЬДЫ (снят на боевом 25.07): form-urlencoded с КВАДРАТНЫМИ СКОБКАМИ,
  // а не JSON-строка в поле payment. Пример полей:
  //   payment[orderid]=1421600022, payment[systranid]=0, payment[amount]=600,
  //   payment[products][0][name]=…, [quantity]=1, [amount]=600, [price]=600,
  //   payment[products][0][externalid]=_11204288, formname=Cart, formid=form238894675
  // Поэтому сначала «разворачиваем» скобки в обычный объект.
  var flat = {};
  Object.keys(body).forEach(function (k) { flat[k] = body[k]; });
  Object.keys(p).forEach(function (k) { if (p[k] != null && p[k] !== '') flat[k] = p[k]; });
  var data = unflattenParams_(flat);

  var pay = data.payment;
  if (typeof pay === 'string') { try { pay = JSON.parse(pay); } catch (ignore2) { pay = null; } }
  pay = pay || {};

  // ─ НОМЕР ЗАКАЗА ─ у Тильды это payment[orderid]. systranid бывает 0 — его не берём.
  var tranid = '';
  [pay.orderid, pay.order_id, pay.systranid, flat.tranid, flat.orderid, data.tranid].forEach(function (v) {
    if (!tranid && v != null && String(v) !== '' && String(v) !== '0') tranid = String(v);
  });

  // ─ СОСТАВ ─ payment.products может быть массивом (из скобок) или объектом {0:{...}}.
  var products = pay.products || data.products || null;
  if (typeof products === 'string') { try { products = JSON.parse(products); } catch (ignore3) { products = null; } }
  if (products && !products.length && typeof products === 'object') {       // объект с числовыми ключами
    products = Object.keys(products).sort().map(function (k) { return products[k]; });
  }

  var items = [];
  (products || []).forEach(function (pr) {
    if (!pr || typeof pr !== 'object') return;
    items.push({
      name: pr.name || pr.title || '',
      externalid: pr.externalid || pr.externalId || pr.external_id || pr.sku,
      sku: pr.sku,
      quantity: Number(pr.quantity || pr.qty || 1) || 1     // ⚠️ НЕ amount: у Тильды amount = сумма
    });
  });
  return { tranid: String(tranid), items: items };
}

// «Разворачивает» поля вида a[b][0][c] в обычный вложенный объект/массив.
function unflattenParams_(flat) {
  var out = {};
  Object.keys(flat).forEach(function (key) {
    var m = String(key).match(/^([^\[]+)((\[[^\]]*\])*)$/);
    if (!m) { out[key] = flat[key]; return; }
    var path = [m[1]];
    var rest = m[2] || '';
    rest.replace(/\[([^\]]*)\]/g, function (_, part) { path.push(part); return ''; });
    var node = out;
    for (var i = 0; i < path.length - 1; i++) {
      var seg = path[i], nextIsIndex = /^\d+$/.test(path[i + 1]);
      if (node[seg] == null || typeof node[seg] !== 'object') node[seg] = nextIsIndex ? [] : {};
      node = node[seg];
    }
    node[path[path.length - 1]] = flat[key];
  });
  return out;
}

// Сырое тело/поля вебхука — для журнала, когда заказ не распознан (обрезаем: там ПД клиента).
function rawOrderPayload_(e) {
  var out = '';
  try { out = (e && e.postData && e.postData.contents) || ''; } catch (ignore) {}
  if (!out) { try { out = JSON.stringify((e && e.parameter) || {}); } catch (ignore) { out = '?'; } }
  return String(out).slice(0, 2000);   // 900 не хватало: русские поля Тильды уходили за обрез
}

// ─── Очередь повторов: позиции, которые не легли в документ ───────────────────
// Зачем: операция создаётся поэтапно (документ → позиции), и если позиция не добавилась,
// остаток спишется не полностью. Молча терять нельзя — кладём в лист «Очередь повторов»,
// пятиминутка добирает. После MAX_RETRY попыток — письмо Ирине и статус «не удалось».
var MAX_RETRY_ = 5;

function retrySheet_() {
  var ss = SpreadsheetApp.openById(requireProp_('CONTROL_SHEET_ID'));
  var sh = ss.getSheetByName('Очередь повторов');
  if (!sh) {
    sh = ss.insertSheet('Очередь повторов');
    sh.appendRow(['Дата', 'Документ', 'Позиция', 'good_id', 'Кол-во', 'Комментарий', 'Попыток', 'Статус', 'Последняя ошибка']);
  }
  return sh;
}

// В очередь попадают только НЕПРОСТАВЛЕННЫЕ ПОДПИСИ. Склад к этому моменту уже изменён верно,
// поэтому повтор ничего не может задвоить — он лишь дописывает комментарий.
function queueRetry_(docId, txId, goodId, amount, comment, error) {
  try {
    retrySheet_().appendRow([new Date(), docId, txId, goodId, amount, comment, 0, 'ждёт', String(error || '').slice(0, 300)]);
  } catch (e) {
    sendErrorEmail_('Не удалось поставить подпись в очередь повторов',
      'Документ ' + docId + ', позиция ' + txId + '. Ошибка: ' + error);
  }
}

// Разбирает очередь. Вызывается пятиминуткой; можно и вручную (?action=retryNow).
function retryPending_() {
  var sh, vals;
  try { sh = retrySheet_(); vals = sh.getDataRange().getValues(); }
  catch (e) { return { ошибка: String(e && e.message || e) }; }
  var master = Number(requireProp_('WRITEOFF_MASTER_ID'));
  var done = 0, still = 0, dead = 0;
  for (var r = 1; r < vals.length; r++) {
    if (String(vals[r][7]) !== 'ждёт') continue;
    var docId = vals[r][1], txId = vals[r][2], goodId = vals[r][3], amount = Number(vals[r][4]) || 1;
    var comment = String(vals[r][5] || ''), tries = Number(vals[r][6]) || 0;
    try {
      setTxComment_(docId, { id: txId, good_id: goodId, amount: amount, cost_per_unit: 0,
        discount: 0, cost: 0, operation_unit_type: 1, master_id: master }, comment);
      sh.getRange(r + 1, 7, 1, 3).setValues([[tries + 1, 'готово', '']]);
      done++;
    } catch (e) {
      var msg = String(e && e.message || e).slice(0, 300);
      if (tries + 1 >= MAX_RETRY_) {
        sh.getRange(r + 1, 7, 1, 3).setValues([[tries + 1, 'не удалось', msg]]);
        sendErrorEmail_('Подпись операции так и не проставилась',
          'Документ ' + docId + ', позиция ' + txId + '. Попыток: ' + (tries + 1) +
          '. Последняя ошибка: ' + msg +
          '\n\nСклад списан ВЕРНО — не хватает только комментария. Можно дописать вручную в YClients.');
        dead++;
      } else {
        sh.getRange(r + 1, 7, 1, 3).setValues([[tries + 1, 'ждёт', msg]]);
        still++;
      }
    }
  }
  if (done || dead) {
    logStatus_('Очередь повторов', dead ? 'ОШИБКА' : 'OK',
      'подписей дописано: ' + done + ', ещё ждут: ' + still + ', не удалось: ' + dead, new Date());
  }
  return { подписей: done, ждут: still, неУдалось: dead };
}

// ─── Сквозная нумерация заказов (нумерация Ирины) ─────────────────────────────
// ORDER_SEQ_NEXT = номер, который получит СЛЕДУЮЩИЙ заказ. Задаётся через
// ?action=setup&ORDER_SEQ_NEXT=<n>, виден в ?action=master. Расходуется только когда есть что
// списывать; повторный вебхук того же заказа отсекается идемпотентностью и номер не тратит.
function nextOrderNo_() {
  // tryLock(2000), НЕ waitLock(10000): тем же замком пользуются прогоны синхронизации (они держат
  // его до 25 с), а заказ ждать не должен — Тильде нужен быстрый ответ. Два заказа в одну секунду
  // практически невозможны, поэтому без замка номер всё равно не задвоится.
  var lock = LockService.getScriptLock();
  try { lock.tryLock(2000); } catch (e) {}
  try {
    var n = Number(prop_('ORDER_SEQ_NEXT') || 1);
    if (!isFinite(n) || n < 1) n = 1;
    props_().setProperty('ORDER_SEQ_NEXT', String(n + 1));
    return n;
  } finally { try { lock.releaseLock(); } catch (e) {} }
}

// ─── Идемпотентность обработанных заказов ─────────────────────────────────────
function isProcessed_(tranid) { return !!prop_('order_' + tranid); }
function markProcessed_(tranid) { props_().setProperty('order_' + tranid, String(new Date())); }

// ─── Диагностика (doGet: только владелец) ─────────────────────────────────────
// Веб-приложение обязано быть анонимным — иначе Тильда не сможет постить вебхук (doPost).
// Но служебные действия анонимными быть не должны: раньше их прикрывал пароль, зашитый в код,
// и любой, кто знал URL и пароль, мог переписать Script Properties или создать складскую
// операцию. Теперь пароля нет вовсе — doGet отвечает ТОЛЬКО владельцу.
// Проверено на боевом 26.07: анонимный вызов /exec → getActiveUser() пустой,
// вызов владельца по /dev с OAuth-токеном → его почта. Значит различение надёжное.
// Как звать: см. скил my-skill-proverka-integracii (@HEAD-деплой /dev + Authorization: Bearer).
function isOwnerCall_() {
  try { return String(Session.getActiveUser().getEmail() || '') === OWNER_EMAIL_; }
  catch (e) { return false; }
}

function doGet(e) {
  var p = (e && e.parameter) || {};
  if (!isOwnerCall_()) { bumpHit_('HITS_GET_DENIED'); return jsonOut_({ ok: false, error: 'forbidden' }); }
  try {
    switch (p.action) {
      case 'ping': return jsonOut_({ ok: true, ts: String(new Date()), owner: true });
      // Разовая установка доступов в Script Properties (значения приходят параметрами).
      case 'setup': {
        var keys = ['PARTNER_TOKEN', 'USER_TOKEN', 'COMPANY_ID', 'WRITEOFF_MASTER_ID', 'TILDA_CML_URL', 'TILDA_CML_LOGIN', 'TILDA_CML_PASS', 'TILDA_PRICE_ID', 'CONTROL_SHEET_ID', 'STORE_STORAGE_ID', 'LAST_SYNC_TS', 'ORDER_SEQ_NEXT', 'TX_SEEN', 'FULL_FEED_HASH', 'FULL_FORCE_DAY'];
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
      // Разовая уборка: удалить пустые строки «изменений нет», накопившиеся до правки 25.07.
      case 'purgeNoise': {
        var shN = statusSheet_(), delN = 0, valsN = shN.getDataRange().getValues();
        for (var rn = valsN.length - 1; rn >= 1; rn--) {
          if (String(valsN[rn][3] || '').trim() === 'изменений нет') { shN.deleteRow(rn + 1); delN++; }
        }
        return jsonOut_({ ok: true, удалено: delN, осталось: shN.getLastRow() - 1 });
      }
      // Переподписать документ (позиции + документ) — если подпись не встала или изменился текст.
      case 'resign': {
        var rd = String(p.doc || ''), rt = String(p.text || '');
        if (!rd || !rt) return jsonOut_({ ok: false, error: 'нужны doc и text' });
        var op = ycGet_('/storage_operations/operation/' + companyId_() + '/' + rd);
        var list = (((op || {}).data || {}).goods_transactions) || [];
        var okTx = 0, errTx = [];
        list.forEach(function (t) {
          try { setTxComment_(rd, t, rt); okTx++; }
          catch (er) { errTx.push(t.id + ': ' + String(er.message).slice(0, 120)); }
        });
        var docOk = true; try { setDocumentComment_(rd, rt); } catch (er) { docOk = String(er.message).slice(0, 120); }
        var after = ycGet_('/storage_operations/operation/' + companyId_() + '/' + rd);
        return jsonOut_({ ok: true, позицийПодписано: okTx, ошибкиПозиций: errTx, документ: docOk,
          проверка: ((((after || {}).data || {}).goods_transactions) || []).map(function (t) { return t.comment; }) });
      }
      case 'retryNow': return jsonOut_({ ok: true, результат: retryPending_() });
      // Письмо-заметка Ирине на OWNER_EMAIL_ (списки к ручной правке, сводки, напоминания).
      // Живёт здесь потому, что почтовый отправитель уже есть, а заводить ради письма отдельный
      // проект — лишнее. Доступно только владельцу (как весь doGet). Ничего не читает и не пишет
      // в данные интеграции: сбой письма не может задеть остатки или заказы.
      case 'mailNote': {
        var mnSubj = String(p.subject || '').trim(), mnText = String(p.text || '').trim();
        if (!mnSubj || !mnText) return jsonOut_({ ok: false, error: 'нужны subject и text' });
        sendErrorEmail_(mnSubj, mnText);
        return jsonOut_({ ok: true, кому: OWNER_EMAIL_, тема: mnSubj, длина: mnText.length });
      }
      // Прочитать складской документ целиком (только чтение) — сверка конкретного заказа.
      case 'opDoc': {
        var od = ycGet_('/storage_operations/operation/' + companyId_() + '/' + String(p.doc || ''));
        var dd = (od || {}).data || {};
        return jsonOut_({ ok: true, документ: dd.document_id || dd.id, тип: dd.type_id, склад: dd.storage_id,
          дата: dd.create_date, комментарий: dd.comment, мастер: dd.master_id,
          позиции: (dd.goods_transactions || []).map(function (t) {
            return { id: t.id, товар: (t.good || {}).title || t.good_id, кол: t.amount,
                     сумма: t.cost, комментарий: t.comment, мастер: t.master_id };
          }) });
      }
      // Какие листы есть в журнал-таблице и сколько в них строк.
      case 'sheets': {
        var ss = SpreadsheetApp.openById(requireProp_('CONTROL_SHEET_ID'));
        return jsonOut_({ ok: true, таблица: ss.getName(), ссылка: ss.getUrl(),
          листы: ss.getSheets().map(function (sh) {
            return { имя: sh.getName(), строк: Math.max(0, sh.getLastRow()), колонок: sh.getLastColumn() };
          }) });
      }
      // Складские и финансовые операции за дату (только чтение) — сверка после заказа.
      case 'opsOn': {
        var d = String(p.date || formatDate_(new Date()).slice(0, 10));
        var tx = ycGet_('/storages/transactions/' + companyId_(), { start_date: d, end_date: d, count: 1000 });
        var fin = ycGet_('/transactions/' + companyId_(), { start_date: d, end_date: d, count: 200 });
        var docCache = {}, txCache = {};
        function docComment(id) {
          if (docCache[id] === undefined) {
            try { docCache[id] = ((ycGet_('/storage_operations/documents/' + companyId_() + '/' + id).data) || {}).comment; }
            catch (er) { docCache[id] = '(не прочитан)'; }
          }
          return docCache[id];
        }
        // ⚠️ Комментарий ПОЗИЦИИ (тот, что виден в СПИСКЕ операций) отдаёт только этот эндпоинт;
        // `/storages/transactions` его всегда возвращает пустым — на этом легко обмануться.
        function txComment(id, txId) {
          if (txCache[id] === undefined) {
            txCache[id] = {};
            try {
              (((ycGet_('/storage_operations/operation/' + companyId_() + '/' + id).data) || {}).goods_transactions || [])
                .forEach(function (t) { txCache[id][t.id] = t.comment; });
            } catch (er) {}
          }
          return txCache[id][txId];
        }
        return jsonOut_({ ok: true, дата: d,
          складские: ((tx && tx.data) || []).map(function (t) {
            return { документ: t.document_id, тип: t.type, кол: t.amount, сумма: t.cost,
                     товар: (t.good || {}).title,
                     комментарийПозиции: txComment(t.document_id, t.id), комментарийДокумента: docComment(t.document_id),
                     время: t.create_date };
          }),
          финансовые: ((fin && fin.data) || []).map(function (f) {
            return { id: f.id, сумма: f.amount, статья: (f.expense || {}).title, комментарий: f.comment };
          }) });
      }
      // Забыть заказ (снять отметку идемпотентности), чтобы обработать его заново.
      case 'forgetOrder': {
        var tid = String(p.tranid || ''); if (!tid) return jsonOut_({ ok: false, error: 'нужен параметр tranid' });
        var had = !!prop_('order_' + tid);
        props_().deleteProperty('order_' + tid);
        return jsonOut_({ ok: true, заказ: tid, былОтмечен: had });
      }
      // Какие заказы приёмник считает обработанными (ключи идемпотентности). Только чтение.
      case 'orderKeys': {
        var allK = props_().getProperties(), rowsK = [];
        Object.keys(allK).forEach(function (k) {
          if (k.indexOf('order_') === 0) rowsK.push({ заказ: k.replace('order_', ''), когда: allK[k] });
        });
        return jsonOut_({ ok: true, всего: rowsK.length, ключи: rowsK });
      }
      // Последние строки журнала (только чтение) — быстрая проверка прогонов и заказов.
      case 'lastLog': {
        var shL = statusSheet_(), n = Number(p.n || 15), valsL = shL.getDataRange().getValues();
        var head = valsL[0], rowsL = valsL.slice(1).slice(-n).map(function (r) {
          return { дата: String(r[0]), операция: r[1], статус: r[2], детали: String(r[3] || '').slice(0, 2500), длительность: r[4] };
        });
        return jsonOut_({ ok: true, всегоСтрок: valsL.length - 1, колонки: head, строки: rowsL });
      }
      // Точечное удаление строк журнала по подстроке (для уборки следов, когда маркера нет).
      case 'purgeMatch': {
        var q = String(p.q || ''); if (!q) return jsonOut_({ ok: false, error: 'нужен параметр q' });
        var shM = statusSheet_(), delM = 0, valsM = shM.getDataRange().getValues();
        for (var rm = valsM.length - 1; rm >= 1; rm--) {
          if (valsM[rm].join(' ').indexOf(q) !== -1) { shM.deleteRow(rm + 1); delM++; }
        }
        return jsonOut_({ ok: true, удалено: delM });
      }
      // Чистка следов тестов: ключи идемпотентности и строки журнала с тестовыми маркерами.
      // Правило Ирины: после тестов история должна быть чистой. Удалить вместе с остальным люком.
      case 'cleanupTests': {
        // Узкие маркеры МОИХ тестов. ⚠️ Не ловить слово «test» вообще: проверочный запрос
        // Тильды выглядит как test=test, и широкий шаблон стирал следы её проверки.
        var MARK = /TEST-|PROBE|PROD-|CHECK-/i;
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
      case 'master': return jsonOut_({ ok: true, masterCount: masterIds_().length, lastSync: prop_('LAST_SYNC_TS'), следующийНомерЗаказа: prop_('ORDER_SEQ_NEXT') || '(не задан → 1)',
        обращенийPOST: prop_('HITS_POST') || 0, последнийPOST: prop_('HITS_POST_LAST') || '—',
        отказовGET: prop_('HITS_GET_DENIED') || 0, последнийОтказGET: prop_('HITS_GET_DENIED_LAST') || '—',
        проверокТильды: prop_('HITS_TILDA_TEST') || 0, последняяПроверкаТильды: prop_('HITS_TILDA_TEST_LAST') || '—' });
      // Создать таблицу-журнал и запомнить её id.
      case 'createControl': { var cs = SpreadsheetApp.create('tilda-yclients — журнал интеграции'); props_().setProperty('CONTROL_SHEET_ID', cs.getId()); statusSheet_(); return jsonOut_({ ok: true, id: cs.getId(), url: cs.getUrl() }); }
      case 'installTriggers': return jsonOut_({ ok: true, triggers: installTriggers_() });
      case 'changedNew': { var cn = changedGoodIdsNew_(); return jsonOut_({ ok: true, изменившихсяТоваров: cn.ids.length, товары: cn.ids, операцийВОкне: cn.операцийВОкне, первыйПрогон: cn.первыйПрогон, границаОкнаСдвинулась: cn.границаОкнаСдвинулась }); }
      // Запомнить текущее состояние без отправки на сайт (чтобы первый прогон не залил всё разом).
      case 'primeTx': { var pt = changedGoodIdsNew_(); return jsonOut_({ ok: true, операцийЗапомнено: pt.операцийВОкне }); }
      case 'runInc': syncStockToTilda_(); return jsonOut_({ ok: true, lastSync: prop_('LAST_SYNC_TS') });
      case 'runFull': { var rf = syncFullToTilda_(); return jsonOut_({ ok: true, результат: rf, lastSync: prop_('LAST_SYNC_TS') }); }
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
// started — начало прогона, чтобы в журнале стояла реальная длительность. Раньше сюда
// подставлялось текущее время, и все ошибки показывали «94 мс» — цифра, которая сбивает с толку
// при разборе (выглядит так, будто прогон и не начинался).
function reportError_(where, e, started) {
  var msg = String((e && e.message) || e);
  sendErrorEmail_('[Тильда↔YClients] Ошибка: ' + where, where + '\n\n' + msg + '\n\n' + (e && e.stack ? e.stack : ''));
  logStatus_(where, 'ОШИБКА', msg, started || null);
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
  // Google при создании таблицы добавляет пустой «Лист1» — он никогда не заполняется и только
  // путает (вопрос Ирины 25.07). Удаляем, если он пуст и есть другие листы.
  try {
    ['Лист1', 'Sheet1'].forEach(function (name) {
      var def = ss.getSheetByName(name);
      if (def && def.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(def);
    });
  } catch (ignore) {}
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
  // Журнальные листы пишутся строго хронологически → режем сверху до первой свежей строки.
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
  total += purgeRetryQueue_(ss, cutoff);
  // старые ключи идемпотентности заказов тоже подчистим (свойства order_*), чтобы не копились
  purgeOldOrderKeys_(cutoff);
  logStatus_('Очистка журнала (раз в месяц)', 'OK', 'удалено строк старше ' + LOG_RETENTION_MONTHS_ + ' мес.: ' + total, now);
  return total;
}

// ⚠️ «Очередь повторов» чистится ОТДЕЛЬНО и НЕ по хронологии (добавлено 30.07 — лист копился
// с самого начала, в уборку не попадал). Резать сверху здесь нельзя: строка «ждёт» — это не
// мусор, а недоставленная подпись, которую пятиминутка ещё доберёт; удалить её = потерять
// работу. Убираем только РАЗОБРАННЫЕ строки («готово» / «не удалось») старше месяца,
// а «ждёт» оставляем при любом возрасте: висит месяц — это сигнал, а не хлам.
function purgeRetryQueue_(ss, cutoff) {
  var sh = ss.getSheetByName('Очередь повторов');
  if (!sh || sh.getLastRow() < 2) return 0;
  var vals = sh.getDataRange().getValues(), del = 0;
  for (var r = vals.length - 1; r >= 1; r--) {
    if (String(vals[r][7]) === 'ждёт') continue;
    var d = vals[r][0];
    var rd = (d instanceof Date) ? d : new Date(String(d).replace('T', ' '));
    if (!isNaN(rd.getTime()) && rd >= cutoff) continue;
    sh.deleteRow(r + 1); del++;
  }
  return del;
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
  ScriptApp.newTrigger('syncStockToTilda_').timeBased().everyMinutes(SYNC_INTERVAL_MIN_).create();   // остатки — 5 мин
  // Полная сверка КАЖДЫЙ ЧАС (решение Ирины 25.07: «нужно, чтобы менялось максимально быстро»).
  // Зачем не только ночью: ИЗМЕНЕНИЕ ЦЕНЫ не создаёт складской операции, поэтому пятиминутка
  // его не видит — цену и новые карточки подтягивает только полная сверка. Стоит ~7 запросов
  // к YClients и ~10 к Тильде за прогон (24 с), то есть даже 24 прогона в сутки — мелочь.
  ScriptApp.newTrigger('syncFullToTilda_').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('purgeOldLogs_').timeBased().onMonthDay(1).atHour(5).create();                 // чистка журнала раз в месяц
  return ScriptApp.getProjectTriggers().map(function (t) { return t.getHandlerFunction(); });
}

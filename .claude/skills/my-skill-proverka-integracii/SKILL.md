---
name: my-skill-proverka-integracii
description: Проверка здоровья интеграции Тильда ↔ YClients (магазин EL'NATUREL) — одной процедурой сверить остатки, заказы, очередь повторов, журнал, триггеры и нагрузку. Применять, когда Ирина спрашивает «всё ли в порядке с сайтом/остатками/заказами», после нескольких реальных онлайн-заказов, после любых правок кода интеграции, при жалобе «на сайте не тот остаток / не та цена / заказ не дошёл», а также в начале новой сессии по этому проекту, чтобы не выяснять состояние вручную.
---

# Проверка здоровья интеграции Тильда ↔ YClients

Цель — за один проход убедиться, что обе стороны живы, и дать Ирине короткий понятный ответ.
Ничего не менять: только чтение. Правки — отдельно, после диагноза («диагностика прежде правок»).

## 0. Доступ (нужен один раз за сессию)

Служебный `doGet` отвечает **только владельцу** (`Session.getActiveUser()` = `OWNER_EMAIL_`);
пароля в запросе нет — с 26.07 он из кода убран. Значит нужен OAuth-токен Ирины.
Боевой деплой (URL вебхука в Тильде) для диагностики НЕ трогаем — работаем по `@HEAD`.

Вход (⚠️ `clasp login --no-localhost` НЕ годится: Google больше не принимает OOB-редирект —
ссылка откроется, но код не выдаст). Рабочий путь — ручной обмен:

1. Установить clasp: `npm install -g @google/clasp@2.4.2`.
2. Собрать ссылку авторизации с `redirect_uri=http://localhost` и клиентом clasp
   (`client_id`/`client_secret` — в `node_modules/@google/clasp/build/src/auth.js`),
   скоупы: `script.projects script.deployments script.webapp.deploy drive.file
   drive.metadata.readonly userinfo.email userinfo.profile cloud-platform
   service.management logging.read`, плюс `access_type=offline&prompt=consent`.
3. Ирина открывает, разрешает, попадает на «сайт недоступен» — **присылает адрес из строки
   браузера целиком** (в нём `code=...`).
4. Обменять `code` на токены (`POST https://oauth2.googleapis.com/token`) и записать
   `~/.clasprc.json` в формате clasp 2.4.2:
   `{ "token": {access_token, refresh_token, scope, token_type, expiry_date},
      "oauth2ClientSettings": {clientId, clientSecret, redirectUri:"http://localhost"},
      "isLocalCreds": false }`.
5. Проверка: `clasp deployments` показывает два деплоя — `@HEAD` и боевой.

⚠️ **`clasp push` из `apps-script/` падает** с `ENOENT: scandir ''` — виноват `rootDir: ""`
в `.clasp.json` (clasp 2.4.2 читает его как путь). Не править файл в репозитории: сделать
во временной папке копию `.clasp.json` с `rootDir` = абсолютный путь к `apps-script`
и запускать `clasp push` оттуда.

## 1. Что проверить — по порядку

| Шаг | Действие | Норма |
|---|---|---|
| 1 | `?action=master` | `lastSync` — не старше 10 минут; `обращенийPOST` растёт после заказов; `отказовGET` = 0 |
| 2 | `?action=changedNew` | `изменившихсяТоваров` = 0 (или столько, сколько реально двигалось) |
| 3 | `?action=retryNow` | `ждут` = 0, `неУдалось` = 0 — все подписи встали |
| 4 | `?action=lastLog&n=10` | нет строк `ОШИБКА`; операции называются «Обновление сайта», «Полная сверка сайта», «Заказ с сайта» |
| 5 | `?action=sheets` | листы: «Статус автоматики», «Очередь повторов» (1 строка = только шапка). Лист «Несопоставленные» появляться НЕ должен |
| 6 | `?action=installTriggers` (только если триггеров нет) | `syncStockToTilda_`, `syncFullToTilda_`, `purgeOldLogs_` |

## 2. Сверка с реальной витриной (когда есть сомнение в остатках)

Ответ «success» от Тильды не доказывает, что данные на сайте. Проверять только через фид:

```
https://store.tildaapi.com/api/getproductslist/?storepartuid=<uid>&recid=<recid>&c=1&getparts=true&getoptions=true&slice=1&size=300
```

Пары `recid`/`storepartuid` — в HTML страницы категории (`recid:'…',storepart:'…'`).
Список страниц брать из `https://elnaturelshop.ru/sitemap.xml`, НЕ по ссылкам с главной
(иначе теряется `/sale`). В ответе у товара `externalid` = `_` + good_id.

⚠️ **Считать только когда ВСЕ запросы прошли.** Один упавший запрос уже давал ошибочный вывод
«10 товаров нет на сайте» вместо 2. Сбой → повтор, а не молчаливо неполная выборка.

## 3. Если заказ «не дошёл»

1. `?action=master` → `обращенийPOST` и `последнийPOST`. Ноль обращений = Тильда к нам вообще
   не стучалась → проблема на её стороне, не в коде.
2. Сравнить с Email/Telegram-приёмщиками того же блока: получили они заказ или нет.
3. ⚠️ Главная причина: **вебхук активируется только при сохранении** и лишь если ответ 200 пришёл
   за 5 секунд. Лечение — ПЕРЕСОЗДАТЬ сервис вебхука в Тильде (пересохранения не хватает).
4. В журнале искать строки «Заказ с сайта» / «Приём заказа с сайта».

## 4. Что сказать Ирине

Коротко, без технических деталей: работает или нет, когда была последняя синхронизация,
есть ли незакрытые ошибки, нужно ли от неё действие. Технику — только если спросит.

## 5. Обязательная уборка после проверки

Если в ходе диагностики создавались тестовые операции или строки журнала — удалить их самому
(`?action=purgeMatch&q=<текст>`), у Ирины к началу работы история должна быть чистой.
Складские документы наш токен удалять НЕ может — если тестовый документ создан, сказать Ирине
прямо, какой именно удалить.

## Шпаргалка: помощник для вызова действий

```bash
#!/bin/bash
# обновляет токен при необходимости и вызывает служебное действие
node -e '
const fs=require("fs");const p=process.env.HOME+"/.clasprc.json";
const s=JSON.parse(fs.readFileSync(p,"utf8"));const t=s.token;const c=s.oauth2ClientSettings;
if(t.expiry_date && t.expiry_date>Date.now()+60000){process.exit(0);}
const body=new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,
  refresh_token:t.refresh_token,grant_type:"refresh_token"});
fetch("https://oauth2.googleapis.com/token",{method:"POST",body}).then(r=>r.json()).then(j=>{
 t.access_token=j.access_token;t.expiry_date=Date.now()+(j.expires_in-120)*1000;
 fs.writeFileSync(p,JSON.stringify(s,null,2));});' 2>/dev/null
sleep 1
AT=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.env.HOME+"/.clasprc.json","utf8")).token.access_token)')
curl -sS -L --max-time 300 -H "Authorization: Bearer $AT" --get \
  "https://script.google.com/macros/s/<HEAD_DEPLOY_ID>/dev" "$@"
```

⚠️ У `@HEAD`-деплоя адрес заканчивается на **`/dev`**, а не `/exec` — с `/exec` Google отдаёт
«Page Not Found», и это легко принять за поломку скрипта.
⚠️ Каждый параметр — отдельным `--data-urlencode`, иначе действие не распознаётся.
⚠️ Для проверки вебхука POST'ом не ставить `-X POST` вместе с `-L`: curl потащит POST на
адрес-эхо и вернёт 405, как будто приёмник сломан. Правильно: `curl -sSL "$URL" -d "test=test"`
(ожидаемо `{"ok":true,"test":true}` за ~2 с).

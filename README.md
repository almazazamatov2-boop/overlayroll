# 🎲 Fate Overlay — Multi-Streamer Edition

Оверлей для Twitch Channel Points. Каждый стример получает:
- Уникальный URL для OBS
- Свои настройки (цвета, название награды, диапазон чисел)
- Свои ассеты (фон панели, картинка награды, 5 звуков)
- Свой дашборд для управления

---

## 🚀 Деплой на Railway (шаг за шагом)

### 1. Создай Twitch App

1. Открой https://dev.twitch.tv/console
2. Нажми **Register Your Application**
3. Name: любое (например `FateOverlay`)
4. OAuth Redirect URLs: `https://YOUR-APP.railway.app/callback`
5. Category: **Other**
6. Сохрани **Client ID** и **Client Secret**

### 2. Подготовь репозиторий

```bash
git init
git add .
git commit -m "init"
```

Загрузи на GitHub (новый репозиторий).

### 3. Задеплой на Railway

1. Открой https://railway.app → **New Project**
2. **Deploy from GitHub repo** → выбери репозиторий
3. Добавь **PostgreSQL plugin**: кнопка `+ New` → `Database` → `PostgreSQL`
4. В настройках сервиса добавь переменные окружения (`Variables`):

| Переменная | Значение |
|---|---|
| `TWITCH_CLIENT_ID` | твой Client ID |
| `TWITCH_CLIENT_SECRET` | твой Client Secret |
| `BASE_URL` | `https://ваш-домен.railway.app` |
| `DATABASE_URL` | Railway подставит автоматически из плагина |
| `PORT` | Railway задаёт сам, можно не добавлять |

> `DATABASE_URL` Railway прокидывает автоматически если PostgreSQL плагин в том же проекте.

5. Нажми **Deploy**

### 4. Подключи Railway Volume для файлов (важно!)

Без Volume файлы теряются при рестарте. Чтобы сохранять загруженные ассеты:

1. В Railway: `+ New` → `Volume`
2. Подключи к сервису, путь монтирования: `/app/uploads`
3. Задеплой снова

### 5. Поправь Redirect URI в Twitch

После деплоя у тебя будет `https://что-то.railway.app`.
Открой Twitch Dev Console → твоё приложение → добавь или обнови:
```
https://your-app.railway.app/callback
```

---

## 👤 Как подключиться стримеру

1. Открыть `https://your-app.railway.app`
2. Нажать **Войти через Twitch**
3. Получить свой Dashboard с URL оверлея
4. В OBS: **Источники** → `+` → **Браузер**
   - URL: тот что в дашборде
   - Ширина: `1600`, Высота: `210`
   - ✅ Прозрачный фон

---

## 🎨 Настройка ассетов

В дашборде можно загрузить:
- `panel_bg` — фоновая картинка панели (PNG/JPG)
- `reward_img` — иконка награды (PNG с прозрачностью)
- `s_in` — звук появления панели (MP3)
- `s_roll` — звук рандома (MP3)
- `s_win` — звук победы (MP3)
- `s_lose` — звук проигрыша (MP3)
- `s_out` — звук исчезновения (MP3)

---

## 🧪 Тест

```
https://your-app.railway.app/test/{streamerId}?user=TestViewer&pick=50
```

---

## 📁 Структура

```
index.js        — основной сервер
db.js           — работа с PostgreSQL
package.json
railway.json
.env.example
uploads/        — загруженные ассеты (нужен Railway Volume)
  {streamerId}/
    panel_bg.png
    reward_img.png
    s_in.mp3
    ...
```

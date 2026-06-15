# Зарплата — Ателье (weekly payroll app)

Mobile-first PWA that calculates each employee's weekly pay from photographed
invoices ("накладные"): photograph → auto-read (Claude vision) → verify →
auto-calculate → clean hand-back sheet. Single operator (the shop owner),
Russian UI.

## Stack

- **Frontend:** React + Vite, installable PWA (manifest + service worker), camera via `<input capture>`
- **Backend:** Node.js + Express; holds the Anthropic API key and proxies photo-reading requests
- **Storage:** SQLite (Node's built-in `node:sqlite`) in `data/payroll.db`; photos in `data/photos/`
- **Vision:** Anthropic Messages API, model `claude-sonnet-4-6` (configurable via `VISION_MODEL`)

## Setup

1. Install dependencies and build the frontend:

   ```
   npm install
   npm --prefix client install
   npm run icons
   npm run build
   ```

2. Edit `.env`:
   - `ANTHROPIC_API_KEY` — required for photo recognition (the app works without it, but invoices must be typed manually)
   - `APP_PIN` — the PIN code to open the app (change from the default!)
   - `SHOP_NAME` — printed on the payout sheet

3. Start:

   ```
   npm start
   ```

   The app listens on `http://0.0.0.0:3000`. Open it from the phone via the
   computer's LAN address (e.g. `http://192.168.1.20:3000`) and use Chrome's
   "Add to Home screen" to install it.

## How it maps to the paper process

- Each employee hands in a stack of invoices weekly. The owner photographs
  them (several stubs per photo is fine), the backend reads `№ накладной`,
  `Итого` and the red «ОПЛАЧЕНО» stamp.
- Every read row is shown for confirmation; low-confidence reads are
  highlighted yellow, rows without the paid stamp are highlighted red and
  excluded from the sum (but stay visible).
- Sum ÷ 2, minus standing deductions (Патент, Аванс), plus/minus one-off
  adjustments → «К выплате».
- The summary sheet mirrors the notebook layout and can be saved as an image
  or copied as text.
- Weekly checks across all employees: duplicate invoice numbers, gaps in the
  number range, unpaid invoices.

## Notes

- Employees are never deleted, only archived — past weeks stay intact.
- All numbers are integers (rubles, no kopecks).
- Photos are kept in `data/photos/` so any row can be re-checked against the
  original.
- Back up the `data/` folder — it contains all weekly records.

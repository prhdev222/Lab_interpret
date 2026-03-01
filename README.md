# 🔬 Lab Interpreter — Deno Deploy + Turso

แปลผล Lab เป็นคำอธิบายสำหรับผู้ป่วย (รองรับภาษาสงฆ์)

## สถาปัตยกรรม

```
┌──────────┐              ┌─────────────────┐              ┌──────────────┐
│ Browser  │  ── PIN ──→  │  Deno Deploy    │  ── Key ──→  │  OpenRouter  │
│ (ไม่มี   │  ← ผลลัพธ์ ─ │  (Backend)      │              │  (AI Model)  │
│  API Key)│              │  API Key ใน env │              └──────────────┘
└──────────┘              │        │        │
                          │   ┌────▼─────┐  │
                          │   │  Turso   │  │
                          │   │  (Users) │  │
                          │   └──────────┘  │
                          └─────────────────┘
```

**ปลอดภัย**: API Key อยู่บน server เท่านั้น — browser ไม่เห็น Key เลย

---

## 🚀 วิธี Deploy (ทีละขั้น)

### ขั้นที่ 1: สมัคร OpenRouter (ฟรี)

1. ไปที่ https://openrouter.ai → สมัครบัญชี
2. ไปที่ **Keys** → สร้าง API Key
3. เก็บ key ไว้ (เช่น `sk-or-v1-xxxx...`)

### ขั้นที่ 2: สร้าง Turso Database (ฟรี)

```bash
# 1. ติดตั้ง Turso CLI
# macOS/Linux:
curl -sSfL https://get.tur.so/install.sh | bash

# 2. สมัครบัญชี
turso auth signup

# 3. สร้าง database
turso db create lab-interpreter

# 4. ดู URL
turso db show lab-interpreter --url
# ได้: libsql://lab-interpreter-xxxxx.turso.io

# 5. สร้าง token
turso db tokens create lab-interpreter
# ได้: eyJhbGciOi...
```

### ขั้นที่ 3: Deploy ขึ้น Deno Deploy (ฟรี)

**วิธี A: ผ่าน GitHub (แนะนำ)**

1. สร้าง GitHub repo ใหม่ → push โค้ดนี้ขึ้นไป
2. ไปที่ https://dash.deno.com → **New Project**
3. เชื่อม GitHub repo → เลือก branch `main`
4. ตั้งค่า:
   - **Entry point**: `main.ts`
   - **Environment Variables** (สำคัญ!):
     ```
     OPENROUTER_API_KEY = sk-or-v1-xxxxx
     OPENROUTER_MODEL   = meta-llama/llama-3.1-8b-instruct:free
     TURSO_URL           = libsql://lab-interpreter-xxxxx.turso.io
     TURSO_AUTH_TOKEN    = eyJhbGciOi...
     DEFAULT_ADMIN_PIN   = 1234
     ```
5. กด **Deploy** → ได้ URL เช่น `https://lab-interpreter.deno.dev`

**วิธี B: ผ่าน CLI**

```bash
# ติดตั้ง Deno
curl -fsSL https://deno.land/install.sh | sh

# ทดสอบ local
cp .env.example .env
# แก้ไขค่าใน .env
deno run --allow-net --allow-read --allow-env main.ts

# Deploy
deno install -Arf jsr:@deno/deployctl
deployctl deploy --project=lab-interpreter main.ts
```

### ขั้นที่ 4: เข้าใช้งาน

1. เปิด URL ที่ได้ (เช่น `https://lab-interpreter.deno.dev`)
2. Login ด้วย:
   - ชื่อผู้ใช้: `admin`
   - PIN: `1234` (หรือที่ตั้งใน DEFAULT_ADMIN_PIN)
3. กดปุ่ม **👥 จัดการผู้ใช้** → เพิ่มหมอ/พยาบาลเข้าระบบ

---

## 📁 โครงสร้างไฟล์

```
lab-interpreter-deno/
├── main.ts              # Deno backend server
├── public/
│   └── index.html       # Frontend (ไม่มี API Key)
├── .env.example         # ตัวอย่าง environment variables
└── README.md            # คู่มือนี้
```

---

## 🔒 ความปลอดภัย

| ส่วน | วิธีป้องกัน |
|------|-----------|
| API Key | เก็บใน Deno Deploy env เท่านั้น ไม่อยู่ใน code หรือ browser |
| PIN ผู้ใช้ | Hash ด้วย SHA-256 เก็บใน Turso |
| Session | Token แบบ random ใน memory หมดอายุ 8 ชม. (1 shift) |
| ข้อมูลผู้ป่วย | ไม่เก็บลง database เลย ใช้แล้วหายไป |
| Admin | ต้องยืนยันตัวตนก่อนจัดการ user |

---

## ⚙️ ปรับแต่ง

### เปลี่ยน Model
แก้ `OPENROUTER_MODEL` ใน env เป็นตัวอื่น:
- `meta-llama/llama-3.1-8b-instruct:free` (ฟรี)
- `google/gemma-2-9b-it:free` (ฟรี)
- `google/gemini-2.0-flash-exp:free` (ฟรี, ฉลาดมาก)
- `anthropic/claude-3.5-sonnet` (เสียเงิน แต่ดีมาก)

### เปลี่ยน Session timeout
แก้ `SESSION_HOURS` ใน `main.ts` (default: 8 ชั่วโมง)

### Custom Domain
ใน Deno Deploy Dashboard → Settings → Domains → เพิ่ม domain เอง

---

## 💰 ค่าใช้จ่าย

| Service | ฟรี | เกินฟรีถ้า... |
|---------|-----|-------------|
| Deno Deploy | 1M req/เดือน | ใช้เกิน 1 ล้าน request |
| Turso | 9 GB + 500M rows read | ไม่มีทางเกินสำหรับ use case นี้ |
| OpenRouter (Free model) | ฟรี | ช่วงคนใช้เยอะอาจช้า |

**สรุป: ฟรีทั้งหมด** สำหรับการใช้งานใน รพ.

# Sepay Balance Bot

Node.js service nhận webhook từ SePay và đẩy thông báo biến động số dư sang Telegram.

## Tính năng

- Nhận webhook POST từ SePay.
- Xác thực header `Authorization: Apikey ...` nếu bạn cấu hình `SEPAY_API_KEY`.
- Chống trùng giao dịch theo `id` của webhook.
- Gửi thông báo sang Telegram bằng Bot API.
- Trả về `201 {"success": true}` để SePay coi là webhook thành công.

## Yêu cầu

- Node.js 18 hoặc mới hơn.
- 1 bot Telegram do BotFather tạo.
- 1 chat id Telegram cá nhân hoặc group.

## Cấu hình

Copy `.env.example` thành file `.env` và điền thông tin.

Biến quan trọng:

- `SEPAY_API_KEY`: API key dùng để xác thực webhook từ SePay.
- `TELEGRAM_BOT_TOKEN`: token bot Telegram.
- `TELEGRAM_CHAT_ID`: chat id cần nhận thông báo.
- `SEPAY_WEBHOOK_PATH`: đường dẫn webhook nội bộ của bạn.

## Chạy

```bash
npm start
```

Hoặc chế độ dev:

```bash
npm run dev
```

## Tạo webhook trên SePay

1. Vào mục WebHooks trong SePay.
2. Gắn URL trỏ về server của bạn, ví dụ:

```text
https://your-domain.com/webhooks/sepay
```

3. Chọn xác thực `API Key` và nhập đúng `SEPAY_API_KEY`.
4. Chọn sự kiện `Có tiền vào`, `Có tiền ra` hoặc cả hai.

Theo tài liệu SePay, webhook sẽ gửi `POST` với dữ liệu JSON và header xác thực dạng `Authorization: Apikey <API_KEY>`.

## Triển khai local

Nếu test trên máy local, bạn có thể dùng tunnel như ngrok hoặc Cloudflare Tunnel để đưa webhook từ SePay vào máy của bạn.

## Deploy lên Render

Render phù hợp nếu bạn muốn một URL public nhanh, cấu hình đơn giản, và không phải tự quản lý server.

1. Đẩy code lên GitHub hoặc GitLab.
2. Vào Render Dashboard, chọn New > Blueprint.
3. Kết nối repo có file `render.yaml`.
4. Render sẽ đọc `render.yaml` và tạo web service tự động.
5. Khi được hỏi secret, nhập:

```text
SEPAY_API_KEY
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
```

6. Sau khi deploy xong, Render cấp cho bạn URL dạng `https://<service-name>.onrender.com`.
7. Dùng URL này làm webhook trên SePay:

```text
https://<service-name>.onrender.com/webhooks/sepay
```

Ghi chú:

- `render.yaml` đang cấu hình `PORT=3000`, khớp với server Node.js.
- Nếu bạn đổi `SEPAY_WEBHOOK_PATH`, phải đổi cả URL webhook trên SePay cho khớp.
- `DEDUPE_FILE` đang trỏ vào đường dẫn trong container; nếu service bị cold start hoặc redeploy, dữ liệu chống trùng có thể mất. Muốn bền hơn thì nên đổi sang Redis hoặc database ngoài.

## Ví dụ nội dung thông báo

- Loại giao dịch.
- Số tiền.
- Số dư lũy kế.
- Ngân hàng.
- Tài khoản.
- Nội dung chuyển khoản.
- Mã tham chiếu.

## Kiểm tra nhanh

- `GET /health` để kiểm tra server sống.
- `POST /webhooks/sepay` để nhận webhook.

## Ghi chú

Dữ liệu webhook thực tế của SePay có thể có thêm trường ngoài các trường được bot đọc. Code đã map linh hoạt các field phổ biến như `gateway`, `transactionDate`, `accountNumber`, `content`, `transferType`, `transferAmount`, `accumulated`, `referenceCode`.

import http from "node:http";
import QRCode from "qrcode";

const PORT = Number(process.env.PORT || 10000);

let latestQR: string | null = null;
let pairingDeviceId: string | null = null;
let botStatus = "starting";

type PairHandler = () => Promise<string>;

let pairHandler: PairHandler | null = null;

export function setPairHandler(handler: PairHandler): void {
  pairHandler = handler;
}

export function setDeviceQR(qr: string | null, deviceId?: string): void {
  latestQR = qr;

  if (qr && deviceId) {
    pairingDeviceId = deviceId;
  }

  if (!qr && deviceId && pairingDeviceId === deviceId) {
    pairingDeviceId = null;
  }
}

export function setDeviceStatus(status: string, deviceId?: string): void {
  botStatus = status;

  if (status === "online" && deviceId && pairingDeviceId === deviceId) {
    latestQR = null;
    pairingDeviceId = null;
  }

  if (status === "offline" && deviceId && pairingDeviceId === deviceId) {
    latestQR = null;
    pairingDeviceId = null;
  }
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown
): void {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });

  res.end(JSON.stringify(data));
}

async function startBrowserPairing(): Promise<string> {
  if (!pairHandler) {
    throw new Error("Browser pairing is not ready yet.");
  }

  if (pairingDeviceId && latestQR) {
    return pairingDeviceId;
  }

  const deviceId = await pairHandler();
  pairingDeviceId = deviceId;
  return deviceId;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );

  if (url.pathname === "/" || url.pathname === "/health") {
    sendJson(res, 200, {
      status: "online",
      bot: "Leo MD",
      botStatus,
      pairingDeviceId,
      pairingAvailable: !!pairHandler,
      qrAvailable: !!latestQR,
      uptime: Math.floor(process.uptime()),
    });
    return;
  }

  if (url.pathname === "/api/pair/start" && req.method === "POST") {
    try {
      const deviceId = await startBrowserPairing();

      sendJson(res, 200, {
        success: true,
        deviceId,
        message: "Pairing started. Waiting for WhatsApp QR code.",
      });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not start pairing.";

      sendJson(res, 500, {
        success: false,
        error: message,
      });
    }
    return;
  }

  if (url.pathname === "/api/pair/status" && req.method === "GET") {
    sendJson(res, 200, {
      status: botStatus,
      deviceId: pairingDeviceId,
      qrAvailable: !!latestQR,
      pairingAvailable: !!pairHandler,
    });
    return;
  }

  if (url.pathname === "/pair") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });

    let content = "";

    if (latestQR) {
      const qrDataURL = await QRCode.toDataURL(latestQR, {
        width: 300,
        margin: 2,
        errorCorrectionLevel: "M",
      });

      content = `
        <img src="${qrDataURL}" alt="WhatsApp QR Code" class="qr">

        <h2>Scan QR Code</h2>

        <p>Open <b>WhatsApp</b> on your phone.</p>

        <p>
          Go to
          <b>Linked Devices → Link a device</b>
        </p>

        <p class="small">
          Scan the QR code to connect
          ${pairingDeviceId || "your device"}.
        </p>

        <div class="status waiting">● WAITING FOR SCAN</div>

        <script>
          setTimeout(() => location.reload(), 5000);
        </script>
      `;
    } else if (
      pairingDeviceId &&
      (botStatus === "starting" || botStatus === "waiting_for_pairing")
    ) {
      content = `
        <div class="icon loading">⏳</div>

        <h2>Starting WhatsApp Pairing</h2>

        <p>Device: <b>${pairingDeviceId}</b></p>

        <p class="small">
          Waiting for the WhatsApp QR code...
        </p>

        <div class="status waiting">
          ● ${botStatus.toUpperCase()}
        </div>

        <script>
          setTimeout(() => location.reload(), 2000);
        </script>
      `;
    } else if (pairHandler) {
      content = `
        <div class="icon">📱</div>

        <h2>Connect WhatsApp</h2>

        <p>
          Click below to create a new Leo MD WhatsApp device.
        </p>

        <button id="pairButton" onclick="startPairing()">
          🔗 Pair WhatsApp
        </button>

        <p id="message" class="small"></p>

        <script>
          async function startPairing() {
            const button = document.getElementById("pairButton");
            const message = document.getElementById("message");

            button.disabled = true;
            button.textContent = "⏳ Starting...";

            try {
              const response = await fetch("/api/pair/start", {
                method: "POST"
              });

              const data = await response.json();

              if (!response.ok || !data.success) {
                throw new Error(
                  data.error || "Could not start pairing."
                );
              }

              message.textContent =
                "Pairing started. Loading QR...";

              setTimeout(() => location.reload(), 1000);
            } catch (error) {
              message.textContent =
                error.message || "Pairing failed.";

              button.disabled = false;
              button.textContent = "🔗 Pair WhatsApp";
            }
          }
        </script>
      `;
    } else {
      content = `
        <div class="icon loading">⏳</div>

        <h2>Leo MD is Starting</h2>

        <p>The pairing system is starting.</p>

        <script>
          setTimeout(() => location.reload(), 3000);
        </script>
      `;
    }

    res.end(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0"
        >

        <meta name="theme-color" content="#080b12">

        <title>Leo MD - WhatsApp Pairing</title>

        <style>
          * { box-sizing: border-box; }

          html, body {
            margin: 0;
            padding: 0;
            width: 100%;
            min-height: 100%;
          }

          body {
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;

            font-family: Arial, Helvetica, sans-serif;
            color: #ffffff;

            background:
              radial-gradient(
                circle at top,
                #172033 0%,
                #0b0f18 45%,
                #05070b 100%
              );
          }

          .container {
            width: 100%;
            max-width: 440px;
            padding: 35px 25px;
            text-align: center;
            border-radius: 25px;

            background: rgba(255, 255, 255, 0.06);
            border: 1px solid rgba(255, 255, 255, 0.10);

            box-shadow:
              0 25px 80px
              rgba(0, 0, 0, 0.45);

            backdrop-filter: blur(18px);
          }

          .logo {
            width: 80px;
            height: 80px;
            margin: 0 auto 15px;

            display: flex;
            align-items: center;
            justify-content: center;

            border-radius: 50%;
            background: rgba(255, 255, 255, 0.08);

            font-size: 42px;
          }

          h1 {
            margin: 0;
            font-size: 30px;
          }

          .subtitle {
            margin-top: 8px;
            margin-bottom: 30px;
            color: #999999;
            font-size: 14px;
          }

          .qr {
            width: 300px;
            max-width: 90%;
            height: auto;
            padding: 10px;
            background: #ffffff;
            border-radius: 18px;
          }

          h2 {
            margin-top: 25px;
            margin-bottom: 10px;
            font-size: 21px;
          }

          p {
            color: #b8b8b8;
            line-height: 1.6;
            font-size: 14px;
          }

          .small {
            color: #777777;
            font-size: 12px;
          }

          .icon {
            font-size: 65px;
            margin-bottom: 15px;
          }

          .loading {
            animation: pulse 1.5s infinite;
          }

          @keyframes pulse {
            0% { opacity: 0.4; }
            50% { opacity: 1; }
            100% { opacity: 0.4; }
          }

          .status {
            display: inline-block;
            margin-top: 20px;
            padding: 8px 15px;
            border-radius: 30px;
            font-size: 12px;
            font-weight: bold;
          }

          .waiting {
            background: rgba(255, 190, 0, 0.12);
            color: #ffc94d;
          }

          button {
            border: 0;
            border-radius: 14px;
            padding: 14px 24px;

            background: #ffffff;
            color: #090c12;

            font-size: 15px;
            font-weight: 700;

            cursor: pointer;

            box-shadow:
              0 10px 30px
              rgba(0, 0, 0, 0.25);
          }

          button:hover {
            transform: translateY(-2px);
          }

          button:disabled {
            opacity: 0.5;
            cursor: wait;
            transform: none;
          }

          .footer {
            margin-top: 30px;
            color: #555555;
            font-size: 11px;
          }
        </style>
      </head>

      <body>
        <main class="container">
          <div class="logo">🤖</div>

          <h1>Leo MD</h1>

          <div class="subtitle">
            WhatsApp AI Bot
          </div>

          ${content}

          <div class="footer">
            Leo MD • Powered by Baileys
          </div>
        </main>
      </body>
      </html>
    `);

    return;
  }

  sendJson(res, 404, {
    status: "error",
    error: "Not Found",
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `🌐 Leo MD Web Server: http://0.0.0.0:${PORT}`
  );
});

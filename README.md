# 🤖 Leo MD

An AI-powered WhatsApp bot built with Node.js, TypeScript and Baileys.

Leo MD provides AI, media, group management, games, stickers, cloud persistence and more — with support for deploying your own instance on Render.

---

## ✨ Features

- 🤖 Groq AI
- 🧠 Persistent Memory
- 🎤 Voice AI
- 🖼️ Image AI
- 🎨 Image Generation
- 🖼️ Sticker Maker
- 👑 Owner System
- 🛡️ Group Admin Tools
- 👤 Private AI
- 👥 Group AI
- 🎮 Games
- 📥 Media Tools
- ☁️ Supabase Cloud Persistence
- 📱 Browser QR Pairing
- 🔄 Automatic Reconnection
- 🌐 Cloud Deployment
- 📊 Web Health Status

---

# 🚀 Deploy Leo MD

You can deploy your own Leo MD instance using **your own cloud account**.

Each user gets their own separate Leo MD instance.

## ☁️ Deploy to Render

Click the button below:

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Pabasaranawo34/Leo-MD)

After clicking the button:

1. Create or sign in to your Render account.
2. Connect your GitHub account if requested.
3. Select the Leo MD repository.
4. Create the Render service.
5. Add the required environment variables.
6. Deploy the service.
7. Wait for the build to finish.
8. Open your Leo MD web URL.
9. Open `/pair` to start WhatsApp pairing.
10. Scan the QR code with WhatsApp.

---

# 🔐 Environment Variables

You need to configure the following environment variables in Render.

```env
GROQ_API_KEY=your_groq_api_key
OPENAI_API_KEY=your_openai_api_key
POLLINATIONS_API_KEY=your_pollinations_api_key

SUPABASE_URL=your_supabase_url
SUPABASE_SECRET_KEY=your_supabase_secret_key

OWNER_NUMBER=your_whatsapp_number
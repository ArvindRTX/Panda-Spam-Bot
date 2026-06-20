# Panda AWM - User Installable Discord Bot 🐼

Panda AWM is a Discord application designed to support **User Installability** (User Apps). Users can install the application directly to their Discord account, allowing them to use its slash commands anywhere—in servers, Group DMs, and Private DMs—even if the bot itself isn't a member of the guild.

## Features
- **User-Installable Integration**: Configure once, use everywhere on Discord.
- **`/ping [message]` Command**: Replies with a button. Clicking the button prints your custom message ephemerally.
- **`/spam [message]` Command**: Replies with a button. Clicking it executes a fast (250ms interval) loop sending 5 separate ephemeral messages containing your custom message text.
- **Crash & Rate-Limit Safe**: Built-in REST rate limit handling and exception safety.

---

## Prerequisites
- [Node.js](https://nodejs.org/) (v16.9.0 or higher)
- A Discord Bot Account with Developer Portal Access

---

## Getting Started

### 1. Installation
Clone or copy the files into your project directory and install the dependencies:
```bash
npm install
```

### 2. Configuration (`.env`)
Create a `.env` file in the root of the project (based on `.env.example`) and populate it with your Discord Bot Token and Client ID:
```env
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
```

### 3. Developer Portal Configuration
For User Installability to work:
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Select your Application and go to the **Installation** tab.
3. Under **Installation Districts**, check **User Install**.
4. Under **User Install Settings**, set the scope to `applications.commands`.
5. Save changes. Use the provided **User Install Link** to add the bot to your Discord account.

### 4. Command Registration
Synchronize your commands with Discord's API:
```bash
npm run register
```

### 5. Running the Bot
Start the bot application:
```bash
npm start
```

---
## File Structure
- `index.js`: Main bot logic, Express server, event listeners, component interactions, and loop handlers.
- `register.js`: Registration script implementing the global slash command payload.
- `.env`: Environment variables configuration.
- `package.json`: NPM package metadata and command scripts.
- `.gitignore`: Excludes local modules, variables, and logs.

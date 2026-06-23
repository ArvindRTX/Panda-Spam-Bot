import { REST, Routes } from 'discord.js';
import 'dotenv/config';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;

if (!token || !clientId || token === 'your_bot_token_here' || clientId === 'your_client_id_here') {
  console.error('Error: Please populate your DISCORD_TOKEN and CLIENT_ID in the .env file before registering commands.');
  process.exit(1);
}

// JSON Payload to register slash commands for User Installability (User Apps)
// integration_types: [1] - USER_INSTALL (Users can install the command to their account)
// contexts: [0, 1, 2] - GUILD, BOT_DM, PRIVATE_CHANNEL (Command can be executed anywhere)
const commands = [
  {
    name: 'ping',
    description: 'Replies with an ephemeral message containing a button',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      {
        name: 'message',
        description: 'The text the bot will reply with when the button is clicked',
        type: 3, // String type
        required: true,
        max_length: 80
      }
    ]
  },
  {
    name: 'spam',
    description: 'Replies with an ephemeral message containing a custom spam button',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      {
        name: 'message',
        description: 'The text the bot will spam when the button is clicked',
        type: 3, // String type
        required: true,
        max_length: 2000
      },
      {
        name: 'delay',
        description: 'Delay in ms between messages (100ms - 5000ms, default: 100ms)',
        type: 4, // Integer type
        required: false,
        min_value: 100,
        max_value: 5000
      },
      {
        name: 'tts',
        description: 'Enable Text-to-Speech (default: false)',
        type: 5, // Boolean type
        required: false
      },
      {
        name: 'embed',
        description: 'Send spammed messages as Rich Embed cards (default: false)',
        type: 5, // Boolean type
        required: false
      },
      {
        name: 'self_destruct',
        description: 'Auto-delete sent messages after specified seconds (1s - 3600s, optional)',
        type: 4, // Integer type
        required: false,
        min_value: 1,
        max_value: 3600
      },
      {
        name: 'ghost_spam',
        description: 'Sends and deletes messages instantly (500ms) (default: false)',
        type: 5, // Boolean type
        required: false
      },
      {
        name: 'panda_raid',
        description: 'Sends animated pandas instead of your message text (default: false)',
        type: 5, // Boolean type
        required: false
      }
    ]
  },
  {
    name: 'customspam',
    description: 'Opens a modal to build a custom embed spam session',
    integration_types: [1],
    contexts: [0, 1, 2]
  },
  {
    name: 'stop',
    description: 'Stops all your currently running spam sequences',
    integration_types: [1],
    contexts: [0, 1, 2]
  },
  {
    name: 'unsend',
    description: 'Deletes all spam messages sent by the bot for you',
    integration_types: [1],
    contexts: [0, 1, 2]
  },
  {
    name: 'authorize',
    description: 'Authorizes a user to use this application (Owner Only)',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      {
        name: 'user',
        description: 'The user to authorize',
        type: 6, // USER type
        required: true
      }
    ]
  },
  {
    name: 'deauthorize',
    description: 'Removes authorization for a user (Owner Only)',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      {
        name: 'user',
        description: 'The user to deauthorize',
        type: 6, // USER type
        required: true
      }
    ]
  },
  {
    name: 'listauthorized',
    description: 'Lists all authorized users (Owner Only)',
    integration_types: [1],
    contexts: [0, 1, 2]
  },
  {
    name: 'spamlogs',
    description: 'Shows the recent spam command logs (Owner Only)',
    integration_types: [1],
    contexts: [0, 1, 2]
  },
  {
    name: 'stopall',
    description: 'Instantly stops all active spam sequences across all users (Owner Only)',
    integration_types: [1],
    contexts: [0, 1, 2]
  },
  {
    name: 'unsendall',
    description: 'Deletes all tracked spam messages sent by the bot for all users (Owner Only)',
    integration_types: [1],
    contexts: [0, 1, 2]
  }
];

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    console.log(`Started refreshing ${commands.length} application (/) commands.`);

    // User-installable commands must be registered globally to be available everywhere
    const data = await rest.put(
      Routes.applicationCommands(clientId),
      { body: commands }
    );

    console.log(`Successfully reloaded ${data.length} application (/) commands.`);
  } catch (error) {
    console.error('Error registering application commands:', error);
  }
})();

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
    description: 'Replies with an ephemeral message containing a spam button',
    integration_types: [1],
    contexts: [0, 1, 2],
    options: [
      {
        name: 'message',
        description: 'The text the bot will spam when the button is clicked',
        type: 3, // String type
        required: true,
        max_length: 80
      }
    ]
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

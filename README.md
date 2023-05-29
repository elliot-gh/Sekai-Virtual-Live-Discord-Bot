# Sekai-Virtual-Live-Discord-Bot

A Discord bot built on [discord.js](https://discord.js.org/) that adds a reminder system specifically for Project Sekai Virtual Live shows. A MongoDB instance is required.

## Instructions

1. Please look at [Discord-Bot-Parent](https://github.com/elliot-gh/Discord-Bot-Parent) to setup the main parent project
2. Copy `config.example.yaml` as `config.yaml` and edit as appropriate
3. Run parent

## Commands

- `/vlive create`: View Virtual Live shows and schedules and create reminderse.
- `/vlive my-reminders`: Lists all own reminders, allowing deletion.
- `/vlive timezone-set`: Set your own timezone, used for schedule display
- `/vlive timezone-get`: View your set timezone

## License

MIT

# Sekai-Virtual-Live-Discord-Bot

A Discord bot built on [discord.js](https://discord.js.org/) that adds a reminder system specifically for Project Sekai Virtual Live shows. A MongoDB instance is required.

## Instructions

1. Please look at [Discord-Bot-Parent](https://github.com/elliot-gh/Discord-Bot-Parent) to setup the main parent project
2. Copy `config.example.yaml` as `config.yaml` and edit as appropriate (you will need MongoDB)
3. Run parent

## Commands

User Commands:

- `/vlive schedule`: View vlive schedule.
- `/vlive reminder auto`: Enable automatically get reminders for all shows.
- `/vlive reminder dismiss`: Dismiss a reminder for a show so you no longer get pinged.
- `/vlive reminder single`: Enable a reminder for a single show.

Admin Commands:

- `/config-vlive channel`: Configure which channel reminders are sent in.
- `/config-vlive new-show`: Enable or disable notifications about new virtual lives found.

## License

MIT

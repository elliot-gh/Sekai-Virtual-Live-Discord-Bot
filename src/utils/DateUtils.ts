import { TimestampStylesString } from "discord.js";

export function subtractMinutesFromDate(date: Date, minutes: number): Date {
    return new Date(date.getTime() - minutes * 60000); // 60000 ms in a minute
}

export function addMinutesToDate(date: Date, minutes: number): Date {
    return new Date(date.getTime() + minutes * 60000); // 60000 ms in a minute
}

export function createDiscordTimestamp(date: Date, style: TimestampStylesString) {
    return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
}

import { RegionString } from "../VirtualLiveShared.js";

export type GuildUserSettings = {
    guildId: string;
    userId: string;
    autoReminders: {
        [region in RegionString]?: UserAutoReminderSettings
    }
};

export type UserAutoReminderSettings = {
    enabled: boolean;
};

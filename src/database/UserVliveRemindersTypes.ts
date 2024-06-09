import { RegionString } from "../VirtualLiveShared.js";

export type UserVliveReminders = {
    guildId: string;
    region: RegionString;
    vliveId: string;
    users: UserReminders[];
}

export type UserReminders = {
    userId: string;
    dismissed: boolean;
}

import { RegionString } from "../VirtualLiveShared.js";

export type GuildSettings = {
    guildId: string;
    isGuildActive: boolean;
    cachedMemberCount: number;
    regionSettings: {
        [region in RegionString]?: GuildRegionSettings
    };
};

export type GuildRegionSettings = {
    channelId: string | undefined;
    newShowsMessage: boolean;
};

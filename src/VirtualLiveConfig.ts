import { RegionString } from "./VirtualLiveShared.js";

/**
 * config.yaml
 */

export type SekaiVirtualLiveConfig = {
    refreshIntervalMinutes: number;
    mongoDbUrl: string;
    agenda: {
        maxConcurrency: number;
        defaultConcurrency: number;
    };
    vliveDataSources: {
        [region in RegionString]?: string;
    };
};

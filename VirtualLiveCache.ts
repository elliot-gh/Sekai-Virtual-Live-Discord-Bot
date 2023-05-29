import axios from "axios";
import { Logger } from "winston";
import { MongoVirtualLive } from "./MongoVirtualLive";
import { SekaiVirtualLiveConfig } from "./SekaiVirtualLiveConfig";
import { VirtualLive, VirtualLiveSchedule } from "./VirtualLiveInterfaces";
import { createLogger } from "../../utils/Logger";

type IdToVlive = {
    [region: string]: {
        [id: number]: VirtualLive
    }
}

type SortedVlives = {
    [region: string]: VirtualLive[]
}

type VliveIdtoScheduleIds = {
    [region: string]: {
        [vliveId: number]: {
            [scheduleId: number]: VirtualLiveSchedule
        }
    }
}

type VliveIdToSortedSchedules = {
    [region: string]: {
        [vliveId: number]: VirtualLiveSchedule[]
    }
}

type RegionToUrls = {
    [region: string]: string
}

export type RegionToNewVliveCount = {
    newFound: boolean,
    regions: {
        [region: string]: NewVliveCount
    }
};

export type NewVliveCount = {
    newCount: number,
    vliveId: number | null
}

export class VirtualLiveCache {
    private readonly logger: Logger;
    private idToVlives: IdToVlive;
    private sortedVlives: SortedVlives;
    private vliveIdsToSchedules: VliveIdtoScheduleIds;
    private sortedSchedules: VliveIdToSortedSchedules;
    private regionToUrls: RegionToUrls;

    constructor(config: SekaiVirtualLiveConfig) {
        this.logger = createLogger("VirtualLiveCache");
        this.idToVlives = {} as IdToVlive;
        this.sortedVlives = {} as SortedVlives;
        this.vliveIdsToSchedules = {} as VliveIdtoScheduleIds;
        this.sortedSchedules = {} as VliveIdToSortedSchedules;
        this.regionToUrls = {};
        for (const regionName in config.sekaiServers) {
            const regionData = config.sekaiServers[regionName];
            this.regionToUrls[regionName] = regionData.vliveDataUrl;
        }

        for (const region in config.sekaiServers) {
            this.idToVlives[region] = {};
            this.sortedVlives[region] = [];
            this.vliveIdsToSchedules[region] = {};
            this.sortedSchedules[region] = [];
        }
    }

    doesRegionExist(region: string) {
        return this.idToVlives[region] !== undefined;
    }

    getSortedVlives(region: string): VirtualLive[] | null {
        if (this.sortedVlives[region].length === 0) {
            return null;
        }

        return this.sortedVlives[region];
    }

    getVliveById(region: string, vliveId: number): VirtualLive | null {
        if (this.idToVlives[region][vliveId] === undefined) {
            return null;
        }

        return this.idToVlives[region][vliveId];
    }

    getSortedSchedules(region: string, vliveId: number): VirtualLiveSchedule[] | null {
        if (this.getVliveById(region, vliveId) === null || this.sortedSchedules[region][vliveId].length === 0) {
            return null;
        }

        return this.sortedSchedules[region][vliveId];
    }

    getScheduleById(region: string, vliveId: number, scheduleId: number): VirtualLiveSchedule | null {
        if (this.getVliveById(region, vliveId) === null || this.vliveIdsToSchedules[region][vliveId][scheduleId] === undefined) {
            return null;
        }

        return this.vliveIdsToSchedules[region][vliveId][scheduleId];
    }

    async refreshCache(onlyRegion: string | null = null): Promise<RegionToNewVliveCount> {
        const currentDate = new Date();
        this.logger.info(`Started refreshCache() at ${currentDate}`);

        try {
            const deleted = await MongoVirtualLive.deleteOlderVirtualLive(currentDate);
            this.logger.info(`Deleted ${deleted} virtual lives`);
        } catch (error) {
            this.logger.error(`Error deleting older virtual lives ${error}`);
        }

        const newVlivesInRegion: RegionToNewVliveCount = {
            newFound: false,
            regions: {}
        };
        for (const region in this.regionToUrls) {
            if (onlyRegion !== null && onlyRegion !== region) {
                continue;
            }

            const url = this.regionToUrls[region];
            this.logger.info(`Refreshing region: ${region} from URL: ${url}`);
            try {
                const updated = await this.downloadAndUpsertVirtualLive(region, url, currentDate);
                newVlivesInRegion.regions[region] = updated;
                if (updated.newCount > 0) {
                    newVlivesInRegion.newFound = true;
                }
            } catch (error) {
                this.logger.error(`Error refreshing region ${region}`);
            }
        }

        if (onlyRegion === null) {
            await this.syncCache();
        } else {
            await this.syncCacheForRegion(onlyRegion);
        }
        this.logger.info("Finished refreshCache()");
        return newVlivesInRegion;
    }

    async syncCache(): Promise<void> {
        this.logger.info(`Begin updateCache() at ${new Date()}`);
        for (const region in this.regionToUrls) {
            this.logger.info(`updateCache() for region ${region}`);
            await this.syncCacheForRegion(region);
        }
        this.logger.info("Finished updateCache()");
    }

    async syncCacheForRegion(region: string): Promise<void> {
        const vlives = await MongoVirtualLive.getAllVirtualLives(region);
        this.sortedVlives[region] = vlives;
        this.idToVlives[region] = {};
        for (const vlive of vlives) {
            this.idToVlives[region][vlive.id] = vlive;
            this.sortedSchedules[region][vlive.id] = vlive.virtualLiveSchedules;
            this.vliveIdsToSchedules[region][vlive.id] = {};
            for (const schedule of vlive.virtualLiveSchedules) {
                this.vliveIdsToSchedules[region][vlive.id][schedule.id] = schedule;
            }
        }
        this.logger.info(`updateCacheForRegion() for region ${region} now has ${vlives.length} virtual lives`);
    }

    private async downloadAndUpsertVirtualLive(region: string, url: string, currentDate: Date): Promise<NewVliveCount> {
        let created = 0;
        let downloaded: VirtualLive[];
        try {
            this.logger.info(`Downloading virtual live URL ${url}`);
            const response = await axios.get(url, {
                responseType: "json"
            });

            const data = response.data;
            downloaded = this.deserializeVirtualLiveJson(data, currentDate);
        } catch (error) {
            this.logger.error(`Got error while downloading ${url}: ${error}`);
            throw error;
        }

        let updated = false;
        let vliveId: number | null = null;
        for (const vlive of downloaded) {
            const upsertedCount = await MongoVirtualLive.createOrupdateVirtualLive(region, vlive);
            created += upsertedCount;
            if (!updated && upsertedCount > 0) {
                updated = true;
                vliveId = vlive.id;
            }
        }

        this.logger.info(`Created ${created} virtual lives for URL ${url}`);
        return {
            newCount: created,
            vliveId: vliveId
        };
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private deserializeVirtualLiveJson(input: any[], currentDate: Date): VirtualLive[] {
        const vlives: VirtualLive[] = [];
        for (const current of input) {
            try {
                if (typeof(current.id) !== "number") {
                    throw new TypeError("id is not a number");
                } else if (typeof(current.virtualLiveType) !== "string") {
                    throw new TypeError("virtualLiveType is not a string");
                } else if (typeof(current.name) !== "string") {
                    throw new TypeError("name is not a string");
                } else if (typeof(current.startAt) !== "number") {
                    throw new TypeError("startAt is not a number");
                } else if (typeof(current.endAt) !== "number") {
                    throw new TypeError("endAt is not a number");
                } else if (!Array.isArray(current.virtualLiveSchedules)) {
                    throw new TypeError("virtualLiveSchedules is not an array");
                } else if (typeof(current.virtualLiveType) !== "string" || current.virtualLiveType.toLowerCase() === "beginner") {
                    continue;
                }

                const currentSchedules: VirtualLiveSchedule[] = [];
                for (const currentSchedule of current.virtualLiveSchedules) {
                    if (typeof(currentSchedule.id) !== "number") {
                        throw new TypeError("currentSchedule.id is not a number");
                    } else if (typeof(currentSchedule.virtualLiveId) !== "number") {
                        throw new TypeError("currentSchedule.virtualLiveId is not a number");
                    } else if (typeof(currentSchedule.seq) !== "number") {
                        throw new TypeError("currentSchedule.seq is not a number");
                    } else if (typeof(currentSchedule.startAt) !== "number") {
                        throw new TypeError("currentSchedule.startAt is not a number");
                    } else if (typeof(currentSchedule.endAt) !== "number") {
                        throw new TypeError("currentSchedule.endAt is not a number");
                    }

                    currentSchedules.push({
                        id: currentSchedule.id,
                        virtualLiveId: currentSchedule.virtualLiveId,
                        seq: currentSchedule.seq,
                        startAt: new Date(currentSchedule.startAt),
                        endAt: new Date(currentSchedule.endAt)
                    });
                }

                if (currentSchedules.length === 0) {
                    continue;
                }

                const vliveEnd = VirtualLiveCache.setEndAt(currentSchedules);
                if (vliveEnd < currentDate) {
                    continue;
                }

                vlives.push({
                    id: current.id,
                    virtualLiveType: current.virtualLiveType,
                    name: current.name,
                    startAt: VirtualLiveCache.setStartAt(currentSchedules),
                    endAt: vliveEnd,
                    virtualLiveSchedules: currentSchedules
                });
            } catch (error) {
                this.logger.error(`deserializeVirtualLiveJson(): Error on the following JSON:\n${JSON.stringify(current)}`);
                continue;
            }
        }

        return vlives;
    }

    private static setStartAt(schedules: VirtualLiveSchedule[]): Date {
        const startSchedule = schedules[0];
        return startSchedule.startAt;
    }

    private static setEndAt(schedules: VirtualLiveSchedule[]): Date {
        const endSchedule = schedules[schedules.length - 1];
        return endSchedule.endAt;
    }
}
import axios from "axios";
import { Logger } from "winston";
import { createLogger } from "../../../utils/Logger.js";
import { MongoVirtualLive } from "./database/MongoVirtualLive.js";
import { RegionString, SekaiVirtualLiveConfig, VirtualLive, VirtualLiveSchedule, isOfTypeRegionString } from "./VirtualLiveShared.js";
import uFuzzy, { IntraMode } from "@leeoniya/ufuzzy";

type IdToVlive = {
    [region in RegionString]?: {
        [vliveId: string]: VirtualLive
    }
}

type SortedVlives = {
    [region in RegionString]?: VirtualLive[]
}

type VliveSearch = {
    [region in RegionString]?: string[]
}

type VliveIdtoScheduleIds = {
    [region in RegionString]?: {
        [vliveId: string]: {
            [scheduleId: string]: VirtualLiveSchedule
        }
    }
}

type VliveIdToSortedSchedules = {
    [region in RegionString]?: {
        [vliveId: string]: VirtualLiveSchedule[]
    }
}

type RegionToUrls = {
    [region in RegionString]?: string
}

export type NewVliveData = {
    newFound: boolean,
    regionsToNewVlives: Map<RegionString, VirtualLive[]>
};

export class VirtualLiveCache {
    private static readonly logger: Logger = createLogger("VirtualLiveCache");
    private static readonly DISCORD_MAX_AUTOCOMPLETE = 25;

    private static alreadyInit: boolean;
    private static regionToUrls: RegionToUrls;
    private static idToVlives: IdToVlive;
    private static allVlives: SortedVlives;
    private static vliveIdsToSchedules: VliveIdtoScheduleIds;
    private static allSchedules: VliveIdToSortedSchedules;
    private static vliveSearch: VliveSearch;
    private static fuzzy: uFuzzy;

    static init(config: SekaiVirtualLiveConfig): void {
        if (this.alreadyInit) {
            return;
        }

        this.idToVlives = {};
        this.allVlives = {};
        this.vliveIdsToSchedules = {};
        this.allSchedules = {};
        this.regionToUrls = {};
        this.vliveSearch = {};
        this.fuzzy = new uFuzzy({
            intraMode: IntraMode.SingleError,

        });

        for (const regionName in config.vliveDataSources) {
            if (!isOfTypeRegionString(regionName)) {
                throw new Error(`Invalid region string in config: ${regionName}`);
            }

            this.regionToUrls[regionName] = config.vliveDataSources[regionName];
            this.idToVlives[regionName] = {};
            this.allVlives[regionName] = [];
            this.vliveIdsToSchedules[regionName] = {};
            this.vliveIdsToSchedules[regionName] = {};
            this.allSchedules[regionName] = {};
        }

        this.alreadyInit = true;
    }

    static getAllVlives(region: RegionString): VirtualLive[] | null {
        if (this.allVlives[region] === undefined) {
            throw new Error(`Region ${region} not found in cache`);
        } else if (this.allVlives[region]!.length === 0) {
            return null;
        }

        return this.allVlives[region]!;
    }

    static getVliveById(region: RegionString, vliveId: string): VirtualLive | null {
        if (this.allVlives[region] === undefined) {
            throw new Error(`Region ${region} not found in cache`);
        } else if (this.idToVlives[region]![vliveId] === undefined) {
            return null;
        }

        return this.idToVlives[region]![vliveId];
    }

    static getAllSchedules(region: RegionString, vliveId: string): VirtualLiveSchedule[] | null {
        if (this.getVliveById(region, vliveId) === null || this.allSchedules[region]![vliveId].length === 0) {
            return null;
        }

        return this.allSchedules[region]![vliveId];
    }

    static getScheduleById(region: RegionString, vliveId: string, scheduleId: string): VirtualLiveSchedule | null {
        if (this.getVliveById(region, vliveId) === null || this.vliveIdsToSchedules[region]![vliveId][scheduleId] === undefined) {
            return null;
        }

        return this.vliveIdsToSchedules[region]![vliveId][scheduleId];
    }

    static searchVlivesByName(region: RegionString, query: string): string[] {
        if (this.allVlives[region] === undefined) {
            throw new Error(`Region ${region} not found in cache`);
        }

        const haystack = this.vliveSearch[region]!;
        const result = this.fuzzy.search(haystack, query, 0, 5);
        const idxs = result[0];
        if (idxs === null || idxs.length === 0) {
            return haystack.slice(0, this.DISCORD_MAX_AUTOCOMPLETE);
        }

        const info = result[1]!;
        const order = result[2]!;
        const results: string[] = [];
        for (let index = 0; index < order.length; index++) {
            results.push(haystack[info.idx[order[index]]]);
        }

        return results;
    }

    static serializeVliveToSearchString(vlive: VirtualLive): string {
        return `${vlive.id} | ${vlive.name}`;
    }

    static getVliveFromSearchString(region: RegionString, searchString: string): VirtualLive | null {
        const split = searchString.split(" | ");
        if (split.length !== 2) {
            return null;
        }

        const vliveId = split[0];
        return this.getVliveById(region, vliveId);
    }

    static deserializeVliveIdFromSearchString(searchString: string): string {
        const split = searchString.split(" | ");
        return split[0];
    }

    /**
     * To be called when the database should be refreshed.
     * @returns A promise that resolves to the number of new virtual lives found.
     */
    static async refreshCacheAndDatabase(): Promise<NewVliveData> {
        const currentDate = new Date();
        this.logger.info(`Started refreshCache() at ${currentDate}`);

        const newVlivesInRegion: NewVliveData = {
            newFound: false,
            regionsToNewVlives: new Map<RegionString, VirtualLive[]>()
        };

        for (const region in this.regionToUrls) {
            if (!isOfTypeRegionString(region)) {
                throw new Error(`Invalid region string in config: ${region}`);
            } else if (this.regionToUrls[region] === undefined) {
                throw new Error(`Region ${region} not found in config`);
            }

            const url = this.regionToUrls[region]!;
            this.logger.info(`Refreshing region: ${region} from URL: ${url}`);
            try {
                const upserted = await this.downloadAndUpsertVirtualLive(region, url, currentDate);
                newVlivesInRegion.regionsToNewVlives.set(region, upserted);
                if (upserted.length > 0) {
                    newVlivesInRegion.newFound = true;
                }

                await this.syncCacheForRegionWithDatabase(region);
            } catch (error) {
                this.logger.error(`Error refreshing region ${region}`);
            }
        }

        this.logger.info(`Finished refreshCache() at ${new Date()}`);
        return newVlivesInRegion;
    }

    static async syncCacheWithDatabase(): Promise<void> {
        for (const region in this.regionToUrls) {
            if (!isOfTypeRegionString(region)) {
                throw new Error(`Invalid region string in config: ${region}`);
            }

            await this.syncCacheForRegionWithDatabase(region);
        }
    }

    private static async syncCacheForRegionWithDatabase(region: RegionString): Promise<void> {
        const vlives = await MongoVirtualLive.getAllVirtualLives(region);
        this.allVlives[region] = vlives;
        this.idToVlives[region] = {};
        this.allSchedules[region] = {};
        this.vliveSearch[region] = [];
        this.vliveIdsToSchedules[region] = {};
        for (const vlive of vlives) {
            this.idToVlives[region]![vlive.id] = vlive;
            this.allSchedules[region]![vlive.id] = vlive.virtualLiveSchedules;
            this.vliveIdsToSchedules[region]![vlive.id] = {};
            this.vliveSearch[region]!.push(this.serializeVliveToSearchString(vlive));
            for (const schedule of vlive.virtualLiveSchedules) {
                this.vliveIdsToSchedules[region]![vlive.id][schedule.id] = schedule;
            }
        }
        this.logger.info(`updateCacheForRegion() for region ${region} now has ${vlives.length} virtual lives`);
    }

    private static async downloadAndUpsertVirtualLive(region: RegionString, url: string, currentDate: Date): Promise<VirtualLive[]> {
        let downloaded: VirtualLive[];
        try {
            this.logger.info(`Downloading virtual live URL ${url}`);
            const response = await axios.get(url, {
                responseType: "json"
            });

            const data = response.data;
            downloaded = this.deserializeVirtualLiveJson(data, currentDate, region);
        } catch (error) {
            this.logger.error(`Got error while downloading ${url}: ${error}`);
            throw error;
        }

        const newVlives: VirtualLive[] = [];
        for (const vlive of downloaded) {
            const upserted = await MongoVirtualLive.createOrupdateVirtualLive(region, vlive);
            if (upserted > 0) {
                newVlives.push(vlive);
            }
        }

        this.logger.info(`Upserted ${newVlives.length} virtual lives for URL ${url}`);
        return newVlives;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private static deserializeVirtualLiveJson(input: any[], currentDate: Date, region: RegionString): VirtualLive[] {
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

                    const startAt = new Date(currentSchedule.startAt);
                    const endAt = new Date(currentSchedule.endAt);
                    if (endAt < currentDate) {
                        continue;
                    }

                    currentSchedules.push({
                        id: currentSchedule.id,
                        virtualLiveId: currentSchedule.virtualLiveId,
                        seq: currentSchedule.seq,
                        startAt: startAt,
                        endAt: endAt,
                        region: region
                    });
                }

                if (currentSchedules.length === 0) {
                    continue;
                }

                currentSchedules.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());

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
                    virtualLiveSchedules: currentSchedules,
                    region: region
                });
            } catch (error) {
                this.logger.error(`deserializeVirtualLiveJson(): Error on the following JSON:\n${JSON.stringify(current)}`);
                continue;
            }
        }

        vlives.sort((a, b) => a.startAt.getTime() - b.startAt.getTime());
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
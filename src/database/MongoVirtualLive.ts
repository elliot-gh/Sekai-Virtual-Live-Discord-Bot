import mongoose, { Connection, Model } from "mongoose";
const { Schema } = mongoose;
import { RegionString, isOfTypeRegionString } from "../VirtualLiveShared.js";
import { SekaiVirtualLiveConfig } from "../VirtualLiveShared.js";
import { VirtualLiveSchedule } from "../VirtualLiveShared.js";
import { VirtualLive } from "../VirtualLiveShared.js";
import { createLogger } from "../../../../utils/Logger.js";
import { addMinutesToDate } from "../utils/DateUtils.js";

/**
 * A collection of vlive Mongoose Models, indexed by region string.
 */
type VliveRegionCollection = {
    [region in RegionString]?: Model<VirtualLive>
};

/**
 * A static class to interact with MongoDB for Virtual Live data.
 */
export class MongoVirtualLive {
    private static readonly COLLECTION_PREFIX = "vliveData_";
    private static readonly MINUTES_AFTER_VLIVE_END_DELETE = 1440; // 1 day
    private static readonly logger = createLogger("MongoVirtualLive");

    private static connection: Connection;
    private static ready = false;
    private static config: SekaiVirtualLiveConfig;
    private static regionToModel: VliveRegionCollection;

    private static readonly virtualLiveScheduleSchema = new Schema<VirtualLiveSchedule>({
        id: { type: String, required: true },
        virtualLiveId: { type: String, required: true },
        seq: { type: Number, required: true },
        startAt: { type: Date, required: true },
        endAt: { type: Date, required: true }
    });

    private static readonly virtualLiveSchema = new Schema<VirtualLive>({
        id: { type: String, required: true, unique: true },
        virtualLiveType: { type: String, required: true },
        name: { type: String, required: true },
        startAt: {  type: Date, required: true },
        endAt: { type: Date, required: true },
        virtualLiveSchedules: { type: [MongoVirtualLive.virtualLiveScheduleSchema], required: true },
    });

    /**
    * Init this class.
    * @param config The SekaiVirtualLiveConfig object containing mongodb connection details.
    * @returns A promise that resolves when the class is ready to use.
    */
    static async init(config: SekaiVirtualLiveConfig, connection: Connection): Promise<void> {
        try {
            if (this.ready) {
                return;
            }

            this.config = config;
            this.connection = connection;
            this.regionToModel = {};
            for (const region in this.config.vliveDataSources) {
                if (!isOfTypeRegionString(region)) {
                    throw new Error(`Invalid region string in config: ${region}`);
                }

                const vliveKey = this.getVirtualLiveCollectionName(region);
                this.regionToModel[region] = this.connection.model<VirtualLive>(vliveKey, this.virtualLiveSchema, vliveKey);
            }

            this.ready = true;
        } catch (error) {
            this.ready = false;
            this.logger.error(`Ran into error in init(): ${error}`);
            throw error;
        }
    }

    /**
     * Get a Virtual Live object from MongoDB.
     * @param region The region of the Virtual Live.
     * @param id The ID of the Virtual Live.
     * @returns A promise that resolves to the Virtual Live object, or null if not found.
     */
    static async getVirtualLive(region: RegionString, id: string): Promise<VirtualLive | null> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        } else if (this.regionToModel[region] === undefined) {
            throw new Error(`Region ${region} not found`);
        }

        const vlive = await this.regionToModel[region]!
            .findOne({ id: id })
            .exec();

        return vlive;
    }

    /**
     * Gets all Virtual Live objects from MongoDB.
     * @param region The region of the Virtual Live.
     * @returns A promise that resolves to an array of Virtual Live objects.
     */
    static async getAllVirtualLives(region: RegionString): Promise<VirtualLive[]> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        } else if (this.regionToModel[region] === undefined) {
            throw new Error(`Region ${region} not found`);
        }

        const vlives = await this.regionToModel[region]!
            .find<VirtualLive>()
            .sort({ startAt: "ascending" })
            .exec();

        return vlives;
    }

    /**
     * Upserts a Virtual Live object into MongoDB.
     * @param region The region of the Virtual Live.
     * @param vlive The Virtual Live object to upsert.
     * @returns A promise that resolves to the number of upserted documents (should be at most 1).
     */
    static async createOrupdateVirtualLive(region: RegionString, vlive: VirtualLive): Promise<number> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        } else if (this.regionToModel[region] === undefined) {
            throw new Error(`Region ${region} not found`);
        }

        const result = await this.regionToModel[region]!
            .updateOne({ id: vlive.id }, vlive, {
                upsert: true
            })
            .exec();

        if (result.upsertedCount > 0) {
            this.logger.info(`Upserted virtual live with ID ${vlive.id} in region ${region}`);
        } else if (result.modifiedCount > 0) {
            this.logger.info(`Modified virtual live with ID ${vlive.id} in region ${region}`);
        }

        return result.upsertedCount;
    }

    /**
     * Deletes Virtual Lives before the current date (minus some time as a buffer).
     * @returns A promise that resolves to the number of deleted documents.
     */
    static async deleteOlderVirtualLives(): Promise<number> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const deleteTime = addMinutesToDate(new Date(), this.MINUTES_AFTER_VLIVE_END_DELETE);
        let numDeleted = 0;
        for (const region in this.regionToModel) {
            if (!isOfTypeRegionString(region)) {
                throw new Error(`Invalid region string in config: ${region}`);
            }

            const deleteResult = await this.regionToModel[region]!
                .deleteMany({ endAt: { $lt: deleteTime } })
                .exec();
            numDeleted += deleteResult.deletedCount;
            this.logger.info(`Deleted ${numDeleted} virtual lives in region ${region}`);
        }

        return numDeleted;
    }

    /**
     * Helper method to format vlive collection names.
     * @param region The region of the Virtual Live.
     * @returns The formatted collection name.
     */
    private static getVirtualLiveCollectionName(region: RegionString): string {
        return `${MongoVirtualLive.COLLECTION_PREFIX}${region}`;
    }
}
import { format } from "node:util";
import mongoose, { Connection, FilterQuery, Model } from "mongoose";
const { Schema } = mongoose;
import { SekaiVirtualLiveConfig } from "./SekaiVirtualLiveConfig";
import { VirtualLive } from "./VirtualLiveInterfaces";
import { createLogger } from "../../utils/Logger";

type VliveRegionCollection = {
    [region: string]: Model<VirtualLive, unknown, unknown, unknown, unknown>
};

type UserTimezone = {
    userId: string,
    timezone: string
};

export class MongoVirtualLive {
    private static connection: Connection;
    private static ready = false;
    private static config: SekaiVirtualLiveConfig;
    private static virtualLiveModels: VliveRegionCollection;
    private static userTimezoneModel: Model<UserTimezone, unknown, unknown, unknown, unknown>;
    private static readonly logger = createLogger("MongoVirtualLive");
    private static readonly virtualLiveScheduleSchema = new Schema({
        id: { type: Number, required: true },
        virtualLiveId: { type: Number, required: true },
        seq: { type: Number, required: true },
        startAt: { type: Date, required: true },
        endAt: { type: Date, required: true }
    });
    private static readonly virtualLiveSchema = new Schema({
        id: { type: String, required: true, unique: true },
        virtualLiveType: { type: String, required: true },
        name: { type: String, required: true },
        startAt: {  type: Date, required: true },
        endAt: { type: Date, required: true },
        virtualLiveSchedules: [MongoVirtualLive.virtualLiveScheduleSchema]
    });
    private static readonly userTimezoneSchema = new Schema({
        userId: { type: String, required: true, unique: true },
        timezone: { type: String, required: true }
    });

    /**
    * Init this class.
    * @param config The SekaiVirtualLiveConfig object containing mongodb connection details.
    */
    static async init(config: SekaiVirtualLiveConfig): Promise<void> {
        try {
            if (this.ready) {
                return;
            }

            this.ready = true;
            this.logger.info(`Trying to connect to MongoDB URL ${config.mongoDb.url}...`);
            const fullUrl = format(config.mongoDb.url,
                encodeURIComponent(config.mongoDb.user),
                encodeURIComponent(config.mongoDb.password));
            this.connection = await mongoose.createConnection(fullUrl).asPromise();

            await this.connection.db.admin().ping();
            this.logger.info(`Connected to MongoDB URL ${config.mongoDb.url}.`);
            this.config = config;
            this.virtualLiveModels = {};
            for (const region in this.config.sekaiServers) {
                const vliveKey = this.getVirtualLiveCollectionName(region);
                this.virtualLiveModels[region] = this.connection.model<VirtualLive>(vliveKey, this.virtualLiveSchema, vliveKey);
            }

            this.userTimezoneModel = this.connection.model<UserTimezone>(this.config.mongoDb.userTimezoneCollection,
                this.userTimezoneSchema, this.config.mongoDb.userTimezoneCollection);
        } catch (error) {
            this.ready = false;
            this.logger.error(`Ran into error in getInstance(): ${error}`);
            if (this.connection !== undefined) {
                await this.connection.close();
            }
            throw error;
        }
    }

    static async getVirtualLive(region: string, id: number): Promise<VirtualLive | null> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const queryObj: FilterQuery<VirtualLive> = {
            id: id
        };

        const vlive = await this.virtualLiveModels[region].findOne(queryObj) as VirtualLive | null;
        return vlive;
    }

    static async getAllVirtualLives(region: string): Promise<VirtualLive[]> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const vlives = await this.virtualLiveModels[region].find<VirtualLive>()
            .sort({ startAt: "ascending" });

        return vlives;
    }

    static async createOrupdateVirtualLive(region: string, vlive: VirtualLive): Promise<number> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const queryObj: FilterQuery<VirtualLive> = {
            id: vlive.id
        };

        const result = await this.virtualLiveModels[region].updateOne(queryObj, vlive, {
            upsert: true
        });

        if (result.upsertedCount > 0) {
            this.logger.info(`Upserted virtual live with ID ${vlive.id} in region ${region}`);
        } else if (result.modifiedCount > 0) {
            this.logger.info(`Modified virtual live with ID ${vlive.id} in region ${region}`);
        }
        return result.upsertedCount;
    }

    static async deleteOlderVirtualLive(currentDate: Date): Promise<number> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const vliveQueryObj: FilterQuery<VirtualLive> = {
            endAt: { $lt: currentDate }
        };

        let numDeleted = 0;
        for (const region in this.virtualLiveModels) {
            numDeleted += (await this.virtualLiveModels[region].deleteMany(vliveQueryObj)).deletedCount;
            this.logger.info(`Deleted ${numDeleted} virtual lives in region ${region}`);
        }

        return numDeleted;
    }

    static async getUserTimezone(userId: string): Promise<string | null> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const queryObj: FilterQuery<UserTimezone> = {
            userId: userId
        };

        const userTimezone = await this.userTimezoneModel.findOne(queryObj) as UserTimezone | null;
        return userTimezone?.timezone ?? null;
    }

    static async createOrUpdateUserTimezone(userId: string, timeZone: string): Promise<number> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const queryObj: FilterQuery<UserTimezone> = {
            userId: userId
        };

        const userTimezone: UserTimezone = {
            userId: userId,
            timezone: timeZone
        };

        const result = await this.userTimezoneModel.updateOne(queryObj, userTimezone, {
            upsert: true
        });

        if (result.upsertedCount > 0) {
            this.logger.info(`Upserted user timezone with ID ${userTimezone.userId} and ${userTimezone.timezone}}`);
        } else if (result.modifiedCount > 0) {
            this.logger.info(`Modified user timezone with ID ${userTimezone.userId} and ${userTimezone.timezone}`);
        }

        return result.upsertedCount;
    }

    private static getVirtualLiveCollectionName(region: string): string {
        return `${this.config.mongoDb.virtualLiveCollection_prefix}${region}`;
    }
}
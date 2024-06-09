import { Connection, Document, Model, Schema } from "mongoose";
import { createLogger } from "../../../../utils/Logger.js";
import { UserReminders, UserVliveReminders } from "./UserVliveRemindersTypes.js";
import { RegionString } from "../VirtualLiveShared.js";

export type UserVliveRemindersDocument = UserVliveReminders & Document;

export class MongoUserVliveReminders {
    private static readonly COLLECTION_NAME = "vliveUserVliveReminders";

    private static readonly logger = createLogger("MongoUserVliveReminders");
    private static connection: Connection;
    private static ready = false;
    private static userVliveRemindersModel: Model<UserVliveReminders>;

    private static readonly userRemindersSchema = new Schema<UserReminders>({
        userId: { type: String, required: true },
        dismissed: { type: Boolean, required: true, default: false }
    });

    private static readonly userVliveRemindersSchema = new Schema<UserVliveReminders>({
        guildId: { type: String, required: true, index: true },
        region: { type: String, required: true, index: true },
        vliveId: { type: String, required: true, index: true },
        users: { type: [this.userRemindersSchema], required: true }
    });

    static async init(connection: Connection): Promise<void> {
        try {
            if (this.ready) {
                return;
            }

            this.connection = connection;
            this.userVliveRemindersModel = this.connection.model<UserVliveReminders>(this.COLLECTION_NAME, this.userVliveRemindersSchema, this.COLLECTION_NAME);
            this.ready = true;
        } catch (error) {
            this.ready = false;
            this.logger.error(`Ran into error in init(): ${error}`);
            throw error;
        }
    }

    static async getUserVliveReminders(guildId: string, region: RegionString, vliveId: string): Promise<UserVliveRemindersDocument | null> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const reminders = await this.userVliveRemindersModel
            .findOne({ guildId: guildId, region: region, vliveId: vliveId })
            .exec();

        return reminders;
    }

    static async deleteUserVliveReminder(region: RegionString, vliveId: string): Promise<number> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const deleteResult = await this.userVliveRemindersModel
            .deleteMany({ region: region, vliveId: vliveId })
            .exec();
        this.logger.info(`Deleted ${deleteResult.deletedCount} user vlive reminders for region ${region} vlive ${vliveId}`);

        return deleteResult.deletedCount;
    }

    static async createEmptyUserVliveReminders(guildId: string, region: RegionString, vliveId: string): Promise<UserVliveRemindersDocument> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const emptySettings: UserVliveReminders = {
            guildId: guildId,
            region: region,
            vliveId: vliveId,
            users: []
        };

        return await this.userVliveRemindersModel.create(emptySettings);
    }

    static async validateAndFixGuildUserVliveReminders(guildId: string, region: RegionString, userId: string, vliveId: string, reminders: UserVliveRemindersDocument | null): Promise<UserVliveRemindersDocument> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        if (reminders === null) {
            return await this.createEmptyUserVliveReminders(guildId, region, vliveId);
        }

        let modified = false;
        if (reminders.users === undefined) {
            reminders.users = [];
            this.logger.warn(`Guild ${guildId} region ${region} vlive ${vliveId} had undefined users; creating empty array`);
            modified = true;
        }

        if (modified) {
            await reminders.save();
        }

        return reminders;
    }
}

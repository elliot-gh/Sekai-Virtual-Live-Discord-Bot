import { Connection, Document, Model, Schema } from "mongoose";
import { createLogger } from "../../../../utils/Logger.js";
import { GuildUserSettings, UserAutoReminderSettings } from "./GuildUserSettingsTypes.js";
import { RegionString } from "../VirtualLiveShared.js";

export type GuildUserSettingsDocument = GuildUserSettings & Document;

export class MongoGuildUserSettings {
    private static readonly COLLECTION_NAME = "vliveGuildUserSettings";

    private static readonly logger = createLogger("MongoGuildUserSettings");
    private static connection: Connection;
    private static ready = false;
    private static guildUserSettingsModel: Model<GuildUserSettings>;

    private static readonly autoReminderSettingsSchema = new Schema<UserAutoReminderSettings>({
        enabled: { type: Boolean, required: true }
    });

    private static readonly guildUserSettingsSchema = new Schema<GuildUserSettings>({
        guildId: { type: String, required: true, index: true },
        userId: { type: String, required: true, index: true },
        autoReminders: {
            English: { type: this.autoReminderSettingsSchema },
            Japanese: { type: this.autoReminderSettingsSchema },
            Korean: { type: this.autoReminderSettingsSchema },
            Taiwanese: { type: this.autoReminderSettingsSchema },
        }
    });

    static async init(connection: Connection): Promise<void> {
        try {
            if (this.ready) {
                return;
            }

            this.connection = connection;
            this.guildUserSettingsModel = this.connection.model<GuildUserSettings>(this.COLLECTION_NAME, this.guildUserSettingsSchema, this.COLLECTION_NAME);
            this.ready = true;
        } catch (error) {
            this.ready = false;
            this.logger.error(`Ran into error in init(): ${error}`);
            throw error;
        }
    }

    static async getUserSettingsForId(guildId: string, userId: string): Promise<GuildUserSettingsDocument | null> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        return await this.guildUserSettingsModel
            .findOne({ guildId: guildId, userId: userId })
            .exec();
    }

    static async getAllEnabledAutoReminderUsers(guildId: string, region: RegionString): Promise<string[]> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const users = await this.guildUserSettingsModel.find(
            {
                guildId: guildId,
                [`autoReminders.${region}.enabled`]: true
            },
            {
                userId: 1
            })
            .exec();

        return users.map(user => user.userId);
    }

    static async createEmptyGuildUserSettingsDocument(guildId: string, userId: string): Promise<GuildUserSettingsDocument> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const emptySettings: GuildUserSettings = {
            guildId: guildId,
            userId: userId,
            autoReminders: {}
        };

        return await this.guildUserSettingsModel.create(emptySettings);
    }

    static async validateAndFixGuildUserSettings(guildId: string, userId: string, settings: GuildUserSettingsDocument | null): Promise<GuildUserSettingsDocument> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        if (settings === null) {
            return await this.createEmptyGuildUserSettingsDocument(guildId, userId);
        }

        let modified = false;
        if (settings.autoReminders === undefined) {
            settings.autoReminders = {};
            this.logger.warn(`autoReminders was undefined for guild ${guildId} and user ${userId}. creating empty object`);
            modified = true;
        }

        if (modified) {
            await settings.save();
        }

        return settings;
    }
}

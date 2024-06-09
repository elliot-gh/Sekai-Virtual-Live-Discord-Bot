import { Connection, Document, Model, Schema } from "mongoose";
import { createLogger } from "../../../../utils/Logger.js";
import { RegionString } from "../VirtualLiveShared.js";
import { GuildRegionSettings, GuildSettings } from "./GuildSettingsTypes.js";
import { Guild } from "discord.js";

export type GuildSettingsDocument = GuildSettings & Document;

export class MongoGuildSettings {
    private static readonly COLLECTION_NAME = "vliveGuildSettings";

    private static readonly logger = createLogger("MongoGuildSettings");
    private static connection: Connection;
    private static ready = false;
    private static guildSettingsModel: Model<GuildSettings>;

    private static readonly guildRegionSettingsSchema = new Schema<GuildRegionSettings>({
        channelId: { type: String },
        newShowsMessage: { type: Boolean, required: true },
    });

    private static readonly guildSettingsSchema = new Schema<GuildSettings>({
        guildId: { type: String, required: true, unique: true, index: true },
        isGuildActive: { type: Boolean, required: true },
        regionSettings: {
            English: { type: this.guildRegionSettingsSchema },
            Japanese: { type: this.guildRegionSettingsSchema },
            Korean: { type: this.guildRegionSettingsSchema },
            Taiwanese: { type: this.guildRegionSettingsSchema },
        }
    });

    static async init(connection: Connection): Promise<void> {
        try {
            if (this.ready) {
                return;
            }

            this.connection = connection;
            this.guildSettingsModel = this.connection.model<GuildSettings>(this.COLLECTION_NAME, this.guildSettingsSchema, this.COLLECTION_NAME);
            this.ready = true;
        } catch (error) {
            this.ready = false;
            this.logger.error(`Ran into error in init(): ${error}`);
            throw error;
        }
    }

    static async getGuildSettingsForId(guildId: string): Promise<GuildSettingsDocument | null> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const guildSettings = await this.guildSettingsModel
            .findOne({ "guildId": guildId })
            .exec();

        return guildSettings;
    }

    static async getGuildsForReminders(region: RegionString): Promise<GuildSettingsDocument[]> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const guildSettings = await this.guildSettingsModel.find(
            {
                "isGuildActive": true,
                [`regionSettings.${region}.channelId`]: {
                    $exists: true
                }
            })
            .exec();

        return guildSettings;
    }

    static async getGuildsForNewShowsMessage(region: RegionString): Promise<GuildSettingsDocument[]> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const guildSettings = await this.guildSettingsModel.find(
            {
                "isGuildActive": true,
                [`regionSettings.${region}.newShowsMessage`]: true,
                [`regionSettings.${region}.channelId`]: {
                    $exists: true
                }
            })
            .exec();

        return guildSettings;
    }

    static async createEmptyGuildSettingsDocument(guild: Guild): Promise<GuildSettingsDocument> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const emptySettings: GuildSettings = {
            guildId: guild.id,
            isGuildActive: true,
            cachedMemberCount: guild.memberCount,
            regionSettings: {}
        };

        return await this.guildSettingsModel.create(emptySettings);
    }

    static async validateAndFixGuildSettings(guild: Guild, settings: GuildSettingsDocument | null): Promise<GuildSettingsDocument> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        if (settings === null) {
            return await this.createEmptyGuildSettingsDocument(guild);
        }

        let modified = false;
        if (settings.regionSettings == undefined) {
            this.logger.warn(`Guild ${guild.id} has no regionSettings. Creating empty object.`);
            modified = true;
            settings.regionSettings = {};
        }

        if (modified) {
            await settings.save();
        }

        return settings;
    }
}

import { Connection, Document, Model, Schema } from "mongoose";
import { Logger } from "winston";
import { createLogger } from "../../../../utils/Logger.js";
import { GuildRegionSettings, GuildSettings, GuildSettingsSettings, GuildUserSettings, GuildVliveRoles, GuildVliveUser, RegionString, UserAutoReminderSettings } from "../VirtualLiveShared.js";

export type GuildSettingsDocument = GuildSettings & Document;
export type GuildUserSettingsDocument = GuildUserSettings & Document;

export class MongoGuildSettings {
    private static readonly COLLECTION_NAME = "vliveGuildSettings";

    private static readonly logger = createLogger("MongoGuildSettings");
    private static connection: Connection;
    private static ready = false;
    private static guildSettingsModel: Model<GuildSettings>;

    private static readonly userAutoReminderSettingsSchema = new Schema<UserAutoReminderSettings>({
        region: { type: String, required: true, unique: true },
        enabled: { type: Boolean, required: true }
    });

    private static readonly guildUserSettingsSchema = new Schema<GuildUserSettings>({
        userId: { type: String, required: true, unique: true },
        autoReminders: { type: [MongoGuildSettings.userAutoReminderSettingsSchema], required: true }
    });

    private static readonly guildVliveUsersSchema = new Schema<GuildVliveUser>({
        userId: { type: String, required: true, unique: true },
        hasRole: { type: Boolean, required: true }
    });

    private static readonly guildVliveRolesSchema = new Schema<GuildVliveRoles>({
        region: { type: String, required: true, unique: true },
        vliveId: { type: String, required: true, unique: true },
        roleId: { type: String, required: true }
    });

    private static readonly guildRegionSettingsSchema = new Schema<GuildRegionSettings>({
        region: { type: String, required: true, unique: true },
        channelId: { type: String, required: true },
        newShowsMessage: { type: Boolean, required: true }
    });

    private static readonly guildSettingsSettingsSchema = new Schema<GuildSettingsSettings>({
        regions: { type: [MongoGuildSettings.guildRegionSettingsSchema], required: true }
    });

    private static readonly guildSettingsSchema = new Schema<GuildSettings>({
        guildId: { type: String, required: true, unique: true, index: true },
        isGuildActive: { type: Boolean, required: true },
        guildSettings: { type: MongoGuildSettings.guildSettingsSettingsSchema, required: true },
        vliveRoles: { type: [MongoGuildSettings.guildVliveRolesSchema], required: true },
        userSettings: { type: [MongoGuildSettings.guildUserSettingsSchema], required: true }
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

    static async getGuildSettings(guildId: string): Promise<GuildSettingsDocument | null> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const guildSettings = await this.guildSettingsModel
            .findOne({ "guildId": guildId })
            .exec();

        return guildSettings;
    }

    static async getActiveGuildSettings(): Promise<GuildSettingsDocument[]> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const guildSettings = await this.guildSettingsModel
            .find({ isGuildActive: true })
            .exec();

        return guildSettings;
    }

    static async getUserIdsWithAutoReminders(guildId: string, region: RegionString): Promise<string[]> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const users = await this.guildSettingsModel
            .find({
                guildId: guildId,
                userSettings: {
                    $elemMatch: {
                        "autoReminders.region": region,
                        "autoReminders.enabled": true
                    }
                }
            })
            .projection({
                "userSettings.userId": 1
            })
            .exec();


        return users as string[];
    }

    static async getGuildsForReminders(region: RegionString): Promise<GuildSettingsDocument[]> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const guilds = await this.guildSettingsModel
            .find({
                guildSettings: {
                    $elemMatch: {
                        "regions.region": region,
                        "regions.newShowsMessage": true
                    }
                }
            })
            .exec();

        return guilds;
    }

    static async createEmptyGuildSettingsDocument(guildId: string): Promise<GuildSettingsDocument> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        return await this.guildSettingsModel.create({
            guildId: guildId,
            isGuildActive: true,
            guildSettings: {
                regions: []
            },
            vliveRoles: [],
            userSettings: []
        });
    }

    static async getVliveRoleSettings(guildId: string, region: RegionString, vliveId: string): Promise<GuildVliveRoles | null> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const settings = await this.guildSettingsModel
            .findOne({
                guildId: guildId,
                vliveRoles: {
                    $elemMatch: {
                        region: region,
                        vliveId: vliveId
                    }
                }
            })
            .projection({
                "vliveRoles.$": 1
            })
            .exec();

        return settings;
    }

    static async setAutoRemindersSettings(guildId: string, userId: string, region: RegionString, enabled: boolean): Promise<void> {
        if (!this.ready) {
            throw new Error("MongoDB connection not ready.");
        }

        const updateResult = await this.guildSettingsModel.findOneAndUpdate({
            guildId: guildId,
            "userSettings.userId": userId
        }, {
            $set: {
                "userSettings.$.autoReminders.$[elem].enabled": enabled
            }
        }, {
            arrayFilters: [{
                "elem.region": region
            }]
        });

        if (updateResult !== null) {
            return;
        }

        // if the user exists but doesn't have an auto reminder setting for the region, create it
        const regionPushResult = await this.guildSettingsModel.findOneAndUpdate({
            guildId: guildId,
            "userSettings.userId": userId
        }, {
            $push: {
                "userSettings.$.autoReminders": {
                    region: region,
                    enabled: enabled
                }
            }
        });

        if (regionPushResult !== null) {
            return;
        }

        // if the user doesn't exist at all, create it
        await this.guildSettingsModel.findOneAndUpdate({
            guildId: guildId
        }, {
            $push: {
                userSettings: {
                    userId: userId,
                    autoReminders: [{
                        region: region,
                        enabled: enabled
                    }]
                }
            }
        });
    }

    static async validateAndFixGuildSettings(logger: Logger, guildId: string, settings: GuildSettingsDocument | null): Promise<GuildSettingsDocument> {
        if (settings === null) {
            return await MongoGuildSettings.createEmptyGuildSettingsDocument(guildId);
        }

        let modified = false;
        if (settings.guildSettings == undefined) {
            logger.warn(`Guild ${guildId} has no guildSettings. Creating empty regions array.`);
            modified = true;
            settings.guildSettings = {
                regions: []
            };
        }

        if (settings.guildSettings.regions == undefined) {
            logger.warn(`Guild ${guildId} has no regions. Creating empty regions array.`);
            modified = true;
            settings.guildSettings.regions = [];
        }

        if (settings.vliveRoles == undefined) {
            logger.warn(`Guild ${guildId} has no vliveRoles. Creating empty array.`);
            modified = true;
            settings.vliveRoles = [];
        }

        if (settings.userSettings == undefined) {
            logger.warn(`Guild ${guildId} has no userSettings. Creating empty array.`);
            modified = true;
            settings.userSettings = [];
        }

        if (modified) {
            await settings.save();
        }

        return settings;
    }
}

import Agenda, { Job } from "agenda";
import { Client, EmbedBuilder, Guild, RoleCreateOptions, TimestampStyles } from "discord.js";
import { createLogger } from "../../../../utils/Logger.js";
import { GuildSettingsDocument, MongoGuildSettings } from "../database/MongoGuildSettings.js";
import { createDiscordTimestamp } from "../utils/DateUtils.js";
import { buildChannelErrorEmbed } from "../utils/DiscordUtils.js";
import { NewVliveData, VirtualLiveCache } from "../VirtualLiveCache.js";
import { GuildRegionSettings, NO_CHANNEL_STR, SekaiVirtualLiveConfig, VirtualLive } from "../VirtualLiveShared.js";
import { VliveReminderJob } from "./VliveReminderJob.js";

type GuildAndSettings = {
    guild: Guild,
    settings: GuildSettingsDocument
};

/**
 * Job to refresh the virtual live data.
 */
export class VliveRefreshJob {
    private static readonly MAX_EMBED_DESC = 4096;
    private static readonly JOB_NAME = "VliveRefreshJob";

    private static readonly logger = createLogger("VliveRefreshJob");
    private static agenda: Agenda;
    private static discordClient: Client;
    private static config: SekaiVirtualLiveConfig;
    private static ready: boolean;

    static async init(agenda: Agenda, discordClient: Client, config: SekaiVirtualLiveConfig): Promise<void> {
        if (this.ready) {
            return;
        }

        this.agenda = agenda;
        this.discordClient = discordClient;
        this.config = config;
        this.agenda.define(this.JOB_NAME, this.handleJob.bind(this));
        this.ready = true;
    }

    static async postReady(): Promise<void> {
        await this.agenda.every(`${this.config.refreshIntervalMinutes} minutes`, this.JOB_NAME);
    }

    static async handleJob(job: Job): Promise<void> {
        if (!this.ready) {
            throw new Error("VirtualLiveRefreshJob not ready.");
        }

        try {
            this.logger.info("Starting Virtual Live data refresh.");
            const newVliveResult = await VirtualLiveCache.refreshCacheAndDatabase();
            if (!newVliveResult.newFound) {
                this.logger.info("No new Virtual Live data found.");
                return;
            }

            this.logger.info("New Virtual Live data found.");
            await VliveReminderJob.scheduleNewJobs(newVliveResult);
            const guilds = await MongoGuildSettings.getActiveGuildSettings();
            const guildsArr: GuildAndSettings[] = [];
            for (let guildSettings of guilds) {
                guildSettings = await MongoGuildSettings.validateAndFixGuildSettings(this.logger, guildSettings.guildId, guildSettings);
                const discordGuild = this.discordClient.guilds.cache.get(guildSettings.guildId);
                if (discordGuild === undefined) {
                    this.logger.error(`Guild not found for id ${guildSettings.guildId}.`);
                    continue;
                }

                const guildAndSettings: GuildAndSettings = {
                    guild: discordGuild,
                    settings: guildSettings
                };

                guildsArr.push(guildAndSettings);
            }

            const promiseArr: Promise<unknown>[] = [];
            promiseArr.push(this.createRoles(newVliveResult, guildsArr));
            promiseArr.push(this.sendMessages(newVliveResult, guildsArr));

            let errStr = "";
            const results = await Promise.allSettled(promiseArr);
            this.logger.info(`Guild operations done: ${results}`);
            for (const result of results) {
                if (result.status === "rejected") {
                    this.logger.error(`Promise rejected in guild operation: ${result.reason}`);
                    errStr += `${result.reason}\n`;
                }
            }

            if (errStr !== "") {
                throw new Error(errStr);
            }
        } catch (error) {
            this.logger.error(`Error in VliveRefreshJob: ${error}`);
            job.fail(error as Error);
            await job.save();
        }
    }

    private static async sendMessages(newData: NewVliveData, guildsAndSettings: GuildAndSettings[]): Promise<void> {
        for (const guildAndSetting of guildsAndSettings) {
            const guild = guildAndSetting.guild;
            const settings = guildAndSetting.settings;
            this.logger.info(`Sending messages for guild ${guild.id}.`);

            for (const [region, newVlives] of newData.regionsToNewVlives) {
                if (newVlives.length === 0) {
                    continue;
                }

                const guildSettingsForRegion = settings.guildSettings.regions.find((r) => r.region === region);
                if (guildSettingsForRegion === undefined || guildSettingsForRegion.channelId === NO_CHANNEL_STR) {
                    continue;
                }

                this.logger.info(`Sending message for region ${region} with ${newVlives.length} new vlives.`);
                const channel = guild.channels.cache.get(guildSettingsForRegion.channelId);
                if (channel === undefined || !channel.isTextBased()) {
                    this.logger.error(`Channel error ${channel?.id} for guild ${guild.id} and region ${region}.`);
                    const defaultChannel = guild.systemChannel;
                    if (defaultChannel === null) {
                        this.logger.error(`Default channel not found for guild ${guild.id}.`);
                        continue;
                    }

                    await defaultChannel.send({ embeds: [buildChannelErrorEmbed(guildSettingsForRegion.channelId)] });
                    continue;
                }

                await channel.send({ embeds: [VliveRefreshJob.buildNewVliveEmbed(newVlives, guildSettingsForRegion)] });
            }

            this.logger.info(`Messages sent for guild ${guild.id}.`);
        }
    }

    private static async createRoles(newData: NewVliveData, guildsAndSettings: GuildAndSettings[]): Promise<void> {
        for (const guildAndSetting of guildsAndSettings) {
            const guild = guildAndSetting.guild;
            const settings = guildAndSetting.settings;
            this.logger.info(`Creating roles for guild ${guild.id}.`);

            for (const [region, newVlives] of newData.regionsToNewVlives) {
                if (newVlives.length === 0) {
                    continue;
                }

                const guildSettingsForRegion = settings.guildSettings.regions.find((r) => r.region === region);
                if (guildSettingsForRegion === undefined || guildSettingsForRegion.channelId === NO_CHANNEL_STR) {
                    continue;
                }

                for (const vlive of newVlives) {
                    const roleOptions: RoleCreateOptions = {
                        name: `Reminder-${region}-${vlive.id}`,
                        hoist: false,
                        position: Number.MAX_SAFE_INTEGER,
                        permissions: undefined,
                        mentionable: false
                    };

                    const role = await guild.roles.create(roleOptions);
                    this.logger.info(`Created role ${role.id} for region ${region} and vlive ${vlive.id}.`);

                    const usersToAdd = await MongoGuildSettings.getUserIdsWithAutoReminders(guild.id, region);
                    if (usersToAdd.length === 0) {
                        continue;
                    }

                    this.logger.info(`Adding ${usersToAdd.length} users to role ${role.id}.`);
                    const memberManager = guild.members;
                    for (const userId of usersToAdd) {
                        await memberManager.addRole({
                            user: userId,
                            role: role,
                        });
                    }

                    const existingRoleSettings = settings.vliveRoles.find((r) => r.region === region && r.vliveId === vlive.id);
                    if (existingRoleSettings !== undefined) {
                        this.logger.info(`Role settings already exist for region ${region} and vlive ${vlive.id}.`);
                        existingRoleSettings.roleId = role.id;
                        continue;
                    } else {
                        settings.vliveRoles.push({
                            region: region,
                            vliveId: vlive.id,
                            roleId: role.id
                        });
                    }

                    await settings.save();
                }
            }

            this.logger.info(`Roles created for guild ${guild.id}.`);
        }
    }

    private static buildNewVliveEmbed(vlives: VirtualLive[], regionSettings: GuildRegionSettings): EmbedBuilder {
        let description = "Want to enable auto reminders? Please look at `/vlive reminders auto`.";
        if (regionSettings.channelId === NO_CHANNEL_STR) {
            description += " **Reminders are disabled until moderators configure the bot. Please look at `/config-vlive reminders`.**";
        }

        description += "\n\n";

        const truncatedString = "*Too many shows were found to list. Please look at `/vlive schedule` to see all shows.*";
        const maxEmbedIncludingTruncated = VliveRefreshJob.MAX_EMBED_DESC - truncatedString.length;

        let currentLength = description.length;
        for (const vlive of vlives) {
            const vliveDesc = `${vlive.name} - ${createDiscordTimestamp(vlive.startAt, TimestampStyles.ShortDateTime)}\n`;

            if (currentLength + vliveDesc.length > maxEmbedIncludingTruncated) {
                description += truncatedString;
                break;
            }

            currentLength += vliveDesc.length;
        }

        return new EmbedBuilder()
            .setTitle("New Virtual Lives found")
            .setDescription(description)
            .addFields([{
                name: "Region",
                value: regionSettings.region
            }])
            .setColor(0x33CCBA);
    }
}

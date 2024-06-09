import Agenda, { Job } from "agenda";
import { Client, EmbedBuilder, Guild, TimestampStyles } from "discord.js";
import { createLogger } from "../../../../utils/Logger.js";
import { GuildRegionSettings } from "../database/GuildSettingsTypes.js";
import { MongoGuildSettings } from "../database/MongoGuildSettings.js";
import { createDiscordTimestamp } from "../utils/DateUtils.js";
import { BIG_GUILD_MEMBERCOUNT, buildErrorEmbed } from "../utils/DiscordUtils.js";
import { VirtualLiveCache } from "../VirtualLiveCache.js";
import { SekaiVirtualLiveConfig } from "../VirtualLiveConfig.js";
import { RegionString, VirtualLive } from "../VirtualLiveShared.js";
import { VliveReminderJob } from "./VliveReminderJob.js";
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

            for (const [region, vliveArr] of newVliveResult.regionsToNewVlives) {
                if (vliveArr.length === 0) {
                    continue;
                }

                const guildSettings = await MongoGuildSettings.getGuildsForNewShowsMessage(region);
                for (const guildSetting of guildSettings) {
                    if (!guildSetting.isGuildActive) {
                        continue;
                    }

                    const guildRegionSettings = guildSetting.regionSettings[region];
                    if (guildRegionSettings === undefined || guildRegionSettings.channelId === undefined || !guildRegionSettings.newShowsMessage) {
                        continue;
                    }

                    const discordGuild = this.discordClient.guilds.cache.get(guildSetting.guildId);
                    if (discordGuild === undefined) {
                        this.logger.error(`Guild not found for id ${guildSetting.guildId}.`);
                        continue;
                    }

                    const discordChannel = await discordGuild.channels.fetch(guildRegionSettings.channelId);
                    if (discordChannel === null || !discordChannel.isTextBased()) {
                        this.logger.error(`Channel not found for id ${guildRegionSettings.channelId}.`);
                        const systemChannel = discordGuild.systemChannel;
                        if (systemChannel !== null) {
                            const errEmbed = buildErrorEmbed(
                                "Channel error",
                                `I tried to send a message but the channel <#${guildRegionSettings.channelId}> (ID \`${guildRegionSettings.channelId}\`) was not found or isn't a text channel.\n\nPlease reconfigure the bot or make sure the bot has access to the channel.`);
                            await systemChannel.send({ embeds: [errEmbed] });
                            continue;
                        }

                        this.logger.error("System channel not found.");
                        continue;
                    }

                    const embed = this.buildNewVliveEmbed(region, vliveArr, guildRegionSettings, discordGuild);
                    await discordChannel.send({ embeds: [embed] });
                }
            }
        } catch (error) {
            this.logger.error(`Error in VliveRefreshJob: ${error}`);
            job.fail(error as Error);
            await job.save();
        }
    }

    private static buildNewVliveEmbed(region: RegionString, vlives: VirtualLive[], regionSettings: GuildRegionSettings, guild: Guild): EmbedBuilder {
        let description = "";
        if (guild.memberCount <= BIG_GUILD_MEMBERCOUNT) {
            description = "Want to enable auto reminders? Please look at `/vlive reminder auto`.\n\n";
        }

        if (regionSettings.channelId === undefined) {
            description += "**Reminders are disabled until moderators configure the bot. Please look at `/config-vlive channel`.**\n\n";
        }

        const truncatedString = "*Too many shows were found to list. Please look at `/vlive schedule` to see all shows.*\n\n";
        const maxEmbedIncludingTruncated = VliveRefreshJob.MAX_EMBED_DESC - truncatedString.length;

        for (const vlive of vlives) {
            const vliveDesc = `${vlive.name} - ${createDiscordTimestamp(vlive.startAt, TimestampStyles.ShortDateTime)}\n`;

            if (description.length + vliveDesc.length > maxEmbedIncludingTruncated) {
                description += truncatedString;
                break;
            }

            description += vliveDesc;
        }

        return new EmbedBuilder()
            .setTitle("New Virtual Lives found")
            .setDescription(description)
            .addFields([{
                name: "Region",
                value: region
            }])
            .setColor(0x33AAEE);
    }
}

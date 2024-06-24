import Agenda, { Job } from "agenda";
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, EmbedBuilder, MessageCreateOptions, TimestampStyles } from "discord.js";
import { createLogger } from "../../../../utils/Logger.js";
import { isOfTypeRegionString, VirtualLive, VirtualLiveSchedule } from "../VirtualLiveShared.js";
import { SekaiVirtualLiveConfig } from "../VirtualLiveConfig.js";
import { NewVliveData, VirtualLiveCache } from "../VirtualLiveCache.js";
import { createDiscordTimestamp, subtractMinutesFromDate } from "../utils/DateUtils.js";
import { MongoGuildSettings } from "../database/MongoGuildSettings.js";
import { buildChannelErrorEmbed, serializeDismissButtonId, serializeSingleOptInButtonId } from "../utils/DiscordUtils.js";
import { MongoGuildUserSettings } from "../database/MongoGuildUserSettings.js";
import { MongoUserVliveReminders } from "../database/MongoUserVliveReminders.js";

type VliveRemindersJobData = {
    region: string,
    vliveId: string,
    scheduleId: string,
    when: Date,
    fallback: {
        name: string,
        startAt: Date,
        endAt: Date
    }
};

export class VliveReminderJob {
    public static readonly JOB_NAME = "VliveReminderJob";

    private static readonly MINUTES_BEFORE_REMINDER = 5;
    private static readonly MAX_USERS_PER_REMINDER = 50;
    private static readonly MAX_TITLE_LENGTH = 256;

    private static readonly logger = createLogger("ReminderJob");
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

    static async scheduleNewJobs(newVlives: NewVliveData): Promise<void> {
        if (!this.ready) {
            throw new Error("ReminderJob not ready.");
        } else if (!newVlives.newFound) {
            return;
        }

        const schedulePromises: Promise<unknown>[] = [];

        for (const [region, vlives] of newVlives.regionsToNewVlives) {
            if (vlives.length === 0) {
                continue;
            }

            for (const vlive of vlives) {
                for (const schedule of vlive.virtualLiveSchedules) {
                    const reminderTime = subtractMinutesFromDate(schedule.startAt, this.MINUTES_BEFORE_REMINDER);
                    this.logger.info(`Scheduling reminder for vlive ${vlive.id} in ${region} at ${reminderTime.toLocaleString()}`);
                    const data: VliveRemindersJobData = {
                        region: region,
                        vliveId: vlive.id,
                        scheduleId: schedule.id,
                        when: reminderTime,
                        fallback: {
                            name: vlive.name,
                            startAt: schedule.startAt,
                            endAt: schedule.endAt
                        }
                    };

                    schedulePromises.push(this.agenda.schedule(reminderTime, this.JOB_NAME, data));
                }
            }
        }

        const results = await Promise.allSettled(schedulePromises);
        for (const result of results) {
            if (result.status === "rejected") {
                this.logger.error(`Error scheduling reminder: ${result.reason}`);
            }
        }
    }

    static async handleJob(job: Job): Promise<void> {
        if (!this.ready) {
            throw new Error("ReminderJob not ready.");
        }

        try {
            const data = job.attrs.data as VliveRemindersJobData;
            if (!data || !data.region || !data.vliveId || !data.scheduleId || !isOfTypeRegionString(data.region)) {
                this.logger.error("Job data is incomplete.");
                job.fail("Job data is incomplete.");
                await job.save();
                return;
            }

            // agenda stores our ids as strings
            data.vliveId = (data.vliveId as unknown as number).toString();
            data.scheduleId = (data.scheduleId as unknown as number).toString();

            this.logger.info(`Sending reminders for vlive ${data.vliveId} in ${data.region} at ${data.when.toLocaleString()}`);
            const guilds = await MongoGuildSettings.getGuildsForReminders(data.region);
            for (let guildSettings of guilds) {
                const discordGuild = this.discordClient.guilds.cache.get(guildSettings.guildId);
                if (discordGuild === undefined) {
                    this.logger.warn(`Guild ${guildSettings.guildId} not found.`);
                    continue;
                }

                guildSettings = await MongoGuildSettings.validateAndFixGuildSettings(discordGuild, guildSettings);
                const regionSettings = guildSettings.regionSettings[data.region];
                if (regionSettings === undefined || regionSettings.channelId == undefined) {
                    this.logger.warn(`No channel set for region ${data.region} in guild ${discordGuild.id}.`);
                    continue;
                }

                const channel = await discordGuild.channels.fetch(regionSettings.channelId);
                if (channel === null || !channel.isTextBased()) {
                    this.logger.error(`Channel ${regionSettings.channelId} not found or not text channel.`);
                    const systemChannel = discordGuild.systemChannel;
                    if (systemChannel === null) {
                        this.logger.error(`System channel not found for guild ${discordGuild.id}.`);
                        continue;
                    }

                    this.logger.info(`Sending error to system channel ${systemChannel.id}.`);
                    const embed = buildChannelErrorEmbed(regionSettings.channelId);
                    await systemChannel.send({ embeds: [embed] });
                    continue;
                }

                const messages: MessageCreateOptions[] = [];
                const embed = this.buildReminderEmbed(data);
                const btnDismiss = new ButtonBuilder()
                    .setCustomId(serializeDismissButtonId(data.region, data.vliveId))
                    .setLabel("Dismiss Reminder")
                    .setStyle(ButtonStyle.Danger);
                const btnOptIn = new ButtonBuilder()
                    .setCustomId(serializeSingleOptInButtonId(data.region, data.vliveId))
                    .setLabel("Add Reminder")
                    .setStyle(ButtonStyle.Primary);

                if (discordGuild.memberCount > this.MAX_USERS_PER_REMINDER) {
                    this.logger.info(`Guild ${discordGuild.id} has more than ${this.MAX_USERS_PER_REMINDER} members, not pinging`);
                    messages.push({ embeds: [embed] });
                } else {
                    const userIds = new Set<string>();
                    const autoReminderUsers = await MongoGuildUserSettings.getAllEnabledAutoReminderUsers(guildSettings.guildId, data.region);
                    for (const userId of autoReminderUsers) {
                        userIds.add(userId);
                    }

                    const singleReminderUsers = await MongoUserVliveReminders.getUserVliveReminders(guildSettings.guildId, data.region, data.vliveId);
                    if (singleReminderUsers !== null) {
                        for (const user of singleReminderUsers.users) {
                            if (user.dismissed) {
                                if (userIds.has(user.userId)) {
                                    userIds.delete(user.userId);
                                    embed.setColor(0xE24740);
                                }

                                continue;
                            }

                            userIds.add(user.userId);
                        }
                    }

                    if (userIds.size === 0) {
                        messages.push({ embeds: [embed], components: [
                            new ActionRowBuilder<ButtonBuilder>().addComponents(btnOptIn)
                        ]});
                    } else {
                        let currentMessage = "";
                        let currentMentions = 0;
                        for (const userId of userIds) {
                            currentMessage += `<@${userId}> `;
                            currentMentions++;

                            if (currentMentions >= this.MAX_USERS_PER_REMINDER) {
                                messages.push({ content: currentMessage, embeds: [embed], components: [
                                    new ActionRowBuilder<ButtonBuilder>().addComponents(btnDismiss, btnOptIn)
                                ]});
                                currentMessage = "";
                                currentMentions = 0;
                            }
                        }

                        if (currentMessage !== "") {
                            messages.push({ content: currentMessage, embeds: [embed], components: [
                                new ActionRowBuilder<ButtonBuilder>().addComponents(btnDismiss, btnOptIn)
                            ]});
                        }
                    }
                }

                this.logger.info(`Sending ${messages.length} messages to ${channel.id} in guild ${discordGuild.id}.`);
                for (const message of messages) {
                    this.logger.info(`Sending reminder with content ${message.content} to ${channel.id} in guild ${discordGuild.id}.`);
                    await channel.send(message);
                }
            }
        } catch (error) {
            this.logger.error(`Error in VliveReminderJob: ${error}`);
            job.fail(error as Error);
            await job.save();
        }
    }

    private static buildReminderEmbed(data: VliveRemindersJobData): EmbedBuilder {
        let vliveFound = true;
        let vlive: VirtualLive | null;
        let schedule: VirtualLiveSchedule | null;
        let isLast = false;

        if (!isOfTypeRegionString(data.region)) {
            this.logger.error(`Invalid region string: ${data.region}`);
            vliveFound = false;
        } else {
            vlive = VirtualLiveCache.getVliveById(data.region, data.vliveId);
            schedule = VirtualLiveCache.getScheduleById(data.region, data.vliveId, data.scheduleId);

            if (vlive === null || schedule === null) {
                this.logger.error(`Vlive ${data.vliveId} or schedule ${data.scheduleId} not found.`);
                vliveFound = false;
            } else {
                const allSchedules = vlive.virtualLiveSchedules;
                isLast = allSchedules[allSchedules.length - 1].id === data.scheduleId;
            }
        }

        let name: string;
        let startAt: Date;
        let endAt: Date;
        if (vliveFound) {
            name = vlive!.name;
            startAt = schedule!.startAt;
            endAt = schedule!.endAt;
        } else {
            name = data.fallback.name;
            startAt = data.fallback.startAt;
            endAt = data.fallback.endAt;
        }

        let description = "";
        if (isLast) {
            description += "**This is the last show of this Virtual Live.**\n";
        }

        if (!vliveFound) {
            description += "*Virtual Live data was not found, so using possibly stale data.*";
        }

        const embed = new EmbedBuilder()
            .setTitle(name.substring(0, this.MAX_TITLE_LENGTH))
            .addFields(
                { name: "Starts at", value: createDiscordTimestamp(startAt, TimestampStyles.LongDateTime), inline: false },
                { name: "Ends at", value: createDiscordTimestamp(endAt, TimestampStyles.LongDateTime), inline: false },
                { name: "Region", value: data.region, inline: false}
            )
            .setColor(0x33CCBA);

        if (description !== "") {
            embed.setDescription(description);
        }

        return embed;
    }
}
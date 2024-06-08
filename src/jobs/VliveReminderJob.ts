import Agenda, { Job } from "agenda";
import { Client, EmbedBuilder, TimestampStyles } from "discord.js";
import { createLogger } from "../../../../utils/Logger.js";
import { isOfTypeRegionString, SekaiVirtualLiveConfig, VirtualLive, VirtualLiveSchedule } from "../VirtualLiveShared.js";
import { NewVliveData, VirtualLiveCache } from "../VirtualLiveCache.js";
import { createDiscordTimestamp, subtractMinutesFromDate } from "../utils/DateUtils.js";
import { MongoGuildSettings } from "../database/MongoGuildSettings.js";
import { buildChannelErrorEmbed } from "../utils/DiscordUtils.js";

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

            this.logger.info(`Sending reminders for vlive ${data.vliveId} in ${data.region} at ${data.when.toLocaleString()}`);
            const guilds = await MongoGuildSettings.getGuildsForReminders(data.region);
            for (let guildSettings of guilds) {
                guildSettings = await MongoGuildSettings.validateAndFixGuildSettings(this.logger, guildSettings.guildId, guildSettings);
                const discordGuild = this.discordClient.guilds.cache.get(guildSettings.guildId);
                if (discordGuild === undefined) {
                    this.logger.error(`Guild ${guildSettings.guildId} not found.`);
                    continue;
                }

                const regionSettings = guildSettings.guildSettings.regions.find((r) => r.region === data.region);
                if (regionSettings === undefined || regionSettings.channelId === "") {
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

                let roleMention = "";
                const roleSettings = await MongoGuildSettings.getVliveRoleSettings(guildSettings.guildId, data.region, data.vliveId);
                if (roleSettings !== null) {
                    roleMention = `<@&${roleSettings.roleId}>`;
                }

                const embed = this.buildReminderEmbed(data);
                await channel.send({
                    content: roleMention,
                    embeds: [embed]
                });
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

        if (!isOfTypeRegionString(data.region)) {
            this.logger.error(`Invalid region string: ${data.region}`);
            vliveFound = false;
        } else {
            vlive = VirtualLiveCache.getVliveById(data.region, data.vliveId);
            schedule = VirtualLiveCache.getScheduleById(data.region, data.vliveId, data.scheduleId);

            if (vlive === null || schedule === null) {
                this.logger.error(`Vlive ${data.vliveId} or schedule ${data.scheduleId} not found.`);
                vliveFound = false;
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

        let description = `Reminder for ${name}.`;
        if (!vliveFound) {
            description += "\n*Virtual Live data was not found, so using possibly stale data.*";
        }

        const embed = new EmbedBuilder()
            .setTitle("Virtual Live Reminder")
            .setDescription(description)
            .addFields(
                { name: "Starts at", value: createDiscordTimestamp(startAt, TimestampStyles.LongDateTime), inline: false },
                { name: "Ends at", value: createDiscordTimestamp(endAt, TimestampStyles.LongDateTime), inline: false },
                { name: "Region", value: data.region, inline: false}
            )
            .setColor(0x33CCBA);

        return embed;
    }
}
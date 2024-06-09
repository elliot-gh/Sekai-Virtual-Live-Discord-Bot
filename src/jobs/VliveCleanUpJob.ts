import Agenda, { Job } from "agenda";
import { Client } from "discord.js";
import { createLogger } from "../../../../utils/Logger.js";
import { SekaiVirtualLiveConfig } from "../VirtualLiveConfig.js";
import { VirtualLiveCache } from "../VirtualLiveCache.js";
import { MongoVirtualLive } from "../database/MongoVirtualLive.js";
import { VliveReminderJob } from "./VliveReminderJob.js";
import { MongoUserVliveReminders } from "../database/MongoUserVliveReminders.js";
import { subtractMinutesFromDate } from "../utils/DateUtils.js";

export class VliveCleanUpJob {
    private static readonly JOB_NAME = "VliveCleanUpJob";
    private static readonly CLEANUP_INTERVAL_MINUTES = 1440; // 24 hours
    private static readonly OLD_JOB_THRESHOLD_MINUTES = 10080; // 1 week

    private static readonly logger = createLogger("VliveCleanUpJob");
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
        if (!this.ready) {
            throw new Error("ReminderJob not ready.");
        }

        await this.agenda.every(`${this.CLEANUP_INTERVAL_MINUTES} minutes`, this.JOB_NAME);
        await this.agenda.now(this.JOB_NAME, {});
    }

    static async handleJob(job: Job): Promise<void> {
        if (!this.ready) {
            throw new Error("ReminderJob not ready.");
        }

        try {
            this.logger.info("Running VliveCleanUpJob.");
            const deletedVlives = await MongoVirtualLive.deleteOlderVirtualLives();
            for (const deleted of deletedVlives) {
                this.logger.info(`Deleted old Virtual Live: ${deleted.name}`);
                const userVliveDeleteResult = await MongoUserVliveReminders.deleteUserVliveReminder(deleted.region, deleted.id);
                this.logger.info(`Deleted ${userVliveDeleteResult} user vlive reminders for ${deleted.name}`);
            }

            await VirtualLiveCache.syncCacheWithDatabase();

            const deleteTime = subtractMinutesFromDate(new Date(), this.OLD_JOB_THRESHOLD_MINUTES);
            const reminderJobs = await this.agenda.jobs({
                name: VliveReminderJob.JOB_NAME,
                nextRunAt: { $lt: deleteTime }
            });

            this.logger.info(`Found ${reminderJobs.length} potential reminder jobs to clean up.`);
            for (const job of reminderJobs) {
                if (job.isRunning() || job.attrs.nextRunAt !== undefined || job.attrs.lastRunAt === undefined) {
                    continue;
                } else if (job.attrs.failedAt !== undefined) {
                    continue;
                }

                this.logger.info(`Removing old reminder job ${job.attrs.name} with last run at ${job.attrs.lastRunAt.toLocaleString()}`);
                await job.remove();
            }
        } catch (error) {
            this.logger.error(`Error in VliveCleanUpJob: ${error}`);
            job.fail(error as Error);
            await job.save();
        }
    }
}
import Agenda from "agenda";
import { Client } from "discord.js";
import { createLogger } from "../../../../utils/Logger.js";
import { SekaiVirtualLiveConfig } from "../VirtualLiveConfig.js";
import { VliveRefreshJob } from "./VliveRefreshJob.js";
import { VliveReminderJob } from "./VliveReminderJob.js";
import { VliveCleanUpJob } from "./VliveCleanUpJob.js";

export class AgendaSetup {
    private static readonly AGENDA_COLLECTION = "vliveBotAgenda";
    private static readonly logger = createLogger("AgendaSetup");

    private static ready: boolean = false;
    private static config: SekaiVirtualLiveConfig;
    private static discordClient: Client;
    private static agenda: Agenda;

    /**
     * Must be called before any jobs run.
     * It is expected that the Discord Client is already logged in.
     * @param config config.yaml
     * @param discordClient The Discord Client object.
     * @returns A promise that resolves when Agenda is connected and jobs are ready to run.
     */
    public static async init(config: SekaiVirtualLiveConfig, discordClient: Client): Promise<void> {
        if (AgendaSetup.ready) {
            return;
        } else if (!discordClient.isReady()) {
            throw new Error("Discord client not ready.");
        }

        this.config = config;
        this.discordClient = discordClient;
        this.agenda = new Agenda({
            db: {
                address: config.mongoDbUrl,
                collection: this.AGENDA_COLLECTION
            },
            maxConcurrency: this.config.agenda.maxConcurrency,
            defaultConcurrency: this.config.agenda.defaultConcurrency
        });

        process.on("SIGTERM", this.handleAgendaShutdown);
        process.on("SIGINT", this.handleAgendaShutdown);
        process.on("SIGHUP", this.handleAgendaShutdown);

        // define jobs here
        // TODO: abstract jobs with a common interface?
        await VliveRefreshJob.init(this.agenda, this.discordClient, this.config);
        await VliveReminderJob.init(this.agenda, this.discordClient, this.config);
        await VliveCleanUpJob.init(this.agenda, this.discordClient, this.config);

        await this.agenda.start();
        this.logger.info("Agenda started.");
        await VliveRefreshJob.postReady();
        await VliveCleanUpJob.postReady();

        AgendaSetup.ready = true;
    }

    public static handleAgendaShutdown(): void {
        if (!AgendaSetup.ready) {
            process.exit(process.exitCode);
        }

        AgendaSetup.logger.info("Got shutdown signal, shutting down Agenda");
        AgendaSetup.agenda.stop()
            .then(() => {
                AgendaSetup.logger.info("Agenda shutdown complete.");
                process.exit(process.exitCode);
            })
            .catch((err) => {
                AgendaSetup.logger.error(`Agenda shutdown error: ${err}`);
                process.exit(process.exitCode);
            });
    }
}

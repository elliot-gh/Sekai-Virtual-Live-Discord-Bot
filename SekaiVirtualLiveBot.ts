/* eslint-disable  @typescript-eslint/no-non-null-assertion */
import Agenda, { Job } from "agenda";
import { GatewayIntentBits, SlashCommandBuilder, ContextMenuCommandBuilder, CommandInteraction, CacheType,
    Client, ButtonInteraction, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, TextChannel,
    WebhookEditMessageOptions, StringSelectMenuBuilder, ChatInputCommandInteraction, TimestampStylesString,
    TimestampStyles, StringSelectMenuInteraction, MessageCreateOptions, StringSelectMenuOptionBuilder,
    TextInputBuilder, TextInputStyle, ModalBuilder, ModalSubmitInteraction } from "discord.js";
import moment from "moment";
import { BotInterface } from "../../BotInterface";
import { readYamlConfig } from "../../utils/ConfigUtils";
import { AbstractReminderBot } from "../Reminder-Discord-Bot/common/AbstractReminderBot";
import { createAgenda } from "../Reminder-Discord-Bot/common/ReminderUtils";
import { VirtualLive, VirtualLiveSchedule } from "./VirtualLiveInterfaces";
import { SekaiVirtualLiveConfig } from "./SekaiVirtualLiveConfig";
import { MongoVirtualLive } from "./MongoVirtualLive";
import { RegionToNewVliveCount, VirtualLiveCache } from "./VirtualLiveCache";
import { ReminderJobData } from "../Reminder-Discord-Bot/common/ReminderJobData";

type ScheduleInfo = {
    region: string,
    vliveId: number,
    scheduleId: number
}

type VliveButtonInfo = {
    region: string,
    vliveId: number
};

export class SekaiVirtualLiveBot extends AbstractReminderBot implements BotInterface {
    private static readonly SUBCMD_CREATE = "create";
    private static readonly SUBCMD_LIST = "my-reminders";
    private static readonly AGENDA_JOB_REMINDER = "agendaJobVirtualLiveReminder";
    private static readonly AGENDA_JOB_REFRESH = "agendaJobVirtualLiveRefresh";
    private static readonly VLIVE_NEW_BTN_PREFIX = "SekaiVliveBot_newVliveBtn__";
    private static readonly VLIVE_SELECT = "SekaiVliveBot_vliveSelect";
    private static readonly VLIVE_BTN_VIEW_SCHEDULE_PREFIX = "SekaiVliveBot_BtnVliveViewSchedules_";
    private static readonly SCHEDULE_SELECT = "SekaiVliveBot_scheduleSelect";
    private static readonly SCHEDULE_BTN_CREATE_PREFIX = "SekaiVliveBot_scheduleBtnCreate_";
    private static readonly SCHEDULE_MODAL_PREFIX = "SekaiVliveBot_scheduleModal_";
    private static readonly SCHEDULE_MODAL_INPUT_MINUTES = "SekaiVliveBot_inputMinutes";

    CLASS_NAME = "SekaiVirtualLiveBot";
    BTN_REM_PREV = "SekaiVliveBot_btnPrev";
    BTN_REM_NEXT = "SekaiVliveBot_btnNext";
    BTN_REM_DEL_PROMPT_PREFIX = "SekaiVliveBot_btnDeletePrompt__";
    BTN_REM_DEL_CONFIRM_PREFIX = "SekaiVliveBot_btnDeleteConfirm__";
    BTN_REM_DEL_CANCEL_PREFIX = "SekaiVliveBot_btnDeleteCancel__";
    REMINDER_TYPE = "Virtual Live reminder";
    REMINDER_TYPE_TITLE = "Virtual Live Reminder";
    REMINDER_TRIGGERED_TITLE = "Upcoming Virtual Live Starting Soon";
    client: Client | null = null;
    agenda: Agenda | null = null;

    private static instance: SekaiVirtualLiveBot;
    intents: GatewayIntentBits[];
    commands: (SlashCommandBuilder | ContextMenuCommandBuilder)[];
    private slashReminder: SlashCommandBuilder;
    private config: SekaiVirtualLiveConfig | null;
    private cache: VirtualLiveCache | null;

    constructor() {
        super();

        this.intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
        this.slashReminder = new SlashCommandBuilder()
            .setName("vlive")
            .setDescription("Set, delete, or view your Project Sekai Virtual Live reminders.")
            .addSubcommand(subcommand =>
                subcommand
                    .setName(SekaiVirtualLiveBot.SUBCMD_LIST)
                    .setDescription("Lists your Virtual Live reminders, which also allows you to delete them.")
            ) as SlashCommandBuilder;
        this.commands = [this.slashReminder];
        this.config = null;
        this.cache = null;

        if (SekaiVirtualLiveBot.instance !== undefined) {
            return;
        }
        SekaiVirtualLiveBot.instance = this;
    }

    async init(): Promise<string | null> {
        try {
            const config = await readYamlConfig<SekaiVirtualLiveConfig>(import.meta, "config.yaml");
            this.config = config;
            this.agenda = await createAgenda(config.mongoDb.url, config.mongoDb.user,
                config.mongoDb.password, config.mongoDb.agendaCollection);
            await MongoVirtualLive.init(this.config);
            this.cache = new VirtualLiveCache(config);
            const command: SlashCommandBuilder = this.commands[0] as SlashCommandBuilder;
            command.addSubcommand(subcommand =>
                subcommand
                    .setName(SekaiVirtualLiveBot.SUBCMD_CREATE)
                    .setDescription("View current Virtual Lives schedules and create reminders.")
                    .addStringOption(option => {
                        option.setName("region")
                            .setDescription("The server region you want to view schedules for.")
                            .setRequired(true);
                        for (const region in config.sekaiServers) {
                            option.addChoices({ name: region, value: region });
                        }

                        return option;
                    })
            );

            this.agenda.define(SekaiVirtualLiveBot.AGENDA_JOB_REMINDER, this.handleReminderJob);
            this.agenda.define(SekaiVirtualLiveBot.AGENDA_JOB_REFRESH, this.refreshVirtualLiveJob);
            return null;
        } catch (error) {
            const errMsg = `[ReminderBot] Error in init(): ${error}`;
            console.error(errMsg);
            return errMsg;
        }
    }

    async processCommand(interaction: CommandInteraction<CacheType>): Promise<void> {
        if (!interaction.isChatInputCommand()) {
            return;
        } else if (interaction.user.id === this.client!.user!.id) {
            return;
        }

        try {
            console.log(`[SekaiVirtualLiveBot] got interaction: ${interaction}`);
            if (interaction.commandName === this.slashReminder.name) {
                switch(interaction.options.getSubcommand()) {
                    case SekaiVirtualLiveBot.SUBCMD_CREATE: {
                        const region = interaction.options.getString("region");
                        await interaction.deferReply({ ephemeral: true });
                        await this.showVirtualLives(interaction, region!, null);
                        break;
                    }
                    case SekaiVirtualLiveBot.SUBCMD_LIST:
                        await this.handleSlashList(interaction);
                        break;
                }
            }
        } catch (error) {
            console.error(`[SekaiVirtualLiveBot] Got error: ${error}`);
        }
    }

    async useClient(client: Client<boolean>): Promise<void> {
        await this.agenda!.start();
        void SekaiVirtualLiveBot.instance.agenda!.every(`${SekaiVirtualLiveBot.instance.config!.refreshIntervalHours} hours`, SekaiVirtualLiveBot.AGENDA_JOB_REFRESH);
        this.client = client;
        client.on("interactionCreate", async (interaction) => {
            if (interaction.user.id === client.user?.id) {
                return;
            }

            if (interaction.isButton()) {
                await this.handleButtonClick(interaction);
            } else if (interaction.isStringSelectMenu()) {
                await this.handleStringSelectMenu(interaction);
            } else if (interaction.isModalSubmit()) {
                await this.handleModalSubmit(interaction);
            }
        });
    }

    async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
        if (!interaction.customId.startsWith(SekaiVirtualLiveBot.SCHEDULE_MODAL_PREFIX)) {
            return;
        }

        console.log(`[SekaiVirtualLiveBot] Got modal submit: ${interaction.customId}`);
        await interaction.deferReply({ ephemeral: true });

        const serializedStr = interaction.customId.substring(SekaiVirtualLiveBot.SCHEDULE_MODAL_PREFIX.length);
        const scheduleInfo = SekaiVirtualLiveBot.deserializeSchedule(serializedStr);
        let vlive = this.cache!.getVliveById(scheduleInfo.region, scheduleInfo.vliveId);
        if (vlive === null) {
            console.log(`[SekaiVirtualLiveBot] handleModalSubmit() could not find virtual live with ID ${scheduleInfo.vliveId} for region ${scheduleInfo.region}, attempting to update`);
            await this.refreshVirtualLive(scheduleInfo.region);
            vlive = this.cache!.getVliveById(scheduleInfo.region, scheduleInfo.vliveId);
            if (vlive === null) {
                console.log(`[SekaiVirtualLiveBot] handleModalSubmit() could not find virtual live with ID ${scheduleInfo.vliveId} for region ${scheduleInfo.region}, returning`);
                const newEmbed = this.buildErrorEmbed("Virtual Live not found", `Selected Virtual Live not found for the ${scheduleInfo.region} server. It may have ended already.`);
                await interaction.editReply({
                    embeds: [newEmbed]
                });
                return;
            }
        }

        const schedule = this.cache!.getScheduleById(scheduleInfo.region, scheduleInfo.vliveId, scheduleInfo.scheduleId);
        if (schedule === null) {
            console.error(`[SekaiVirtualLiveBot] handleCreateScheduleButtonClick() could not find schedule ${scheduleInfo.scheduleId} for region ${scheduleInfo.region}, returning`);
            const newEmbed = this.buildErrorEmbed("Virtual Live schedule could not be found", `Could not find that Virtual Live schedule for the ${scheduleInfo.region} server. It may have ended already.`);
            await interaction.editReply({
                embeds: [newEmbed]
            });
            return;
        }

        const minutesStr = interaction.fields.getTextInputValue(SekaiVirtualLiveBot.SCHEDULE_MODAL_INPUT_MINUTES);
        let remindTime: Date;
        try {
            remindTime = schedule.startAt;
            const minutes = parseInt(minutesStr);
            if (minutes < 0) {
                throw new Error(`negative minutes: ${minutes}`);
            } else if (minutes > 0) {
                remindTime = SekaiVirtualLiveBot.subtractMinutes(schedule.startAt, minutes);
            }
        } catch (error) {
            const errorEmbed = this.buildErrorEmbed("Invalid Input", "The passed in minutes was not a valid number.");
            await interaction.editReply({ embeds: [errorEmbed] });
            return;
        }

        const description = `Reminder for Sekai Virtual Live show:\n${vlive.name}\n\nVirtual Live starts at: ${SekaiVirtualLiveBot.createDiscordTimestamp(schedule.startAt, TimestampStyles.LongDateTime)}`;
        const jobData: ReminderJobData = {
            userId: interaction.user.id,
            channelId: interaction.channelId!,
            guildId: interaction.guildId!,
            description: description,
            messageUrl: null
        };

        const embed = await this.createReminder(jobData, remindTime, SekaiVirtualLiveBot.AGENDA_JOB_REMINDER);
        await interaction.editReply({ embeds: [embed] });
    }

    async handleButtonClick(interaction: ButtonInteraction<CacheType>): Promise<void> {
        if (interaction.customId === this.BTN_REM_PREV ||
            interaction.customId === this.BTN_REM_NEXT ||
            interaction.customId.startsWith(this.BTN_REM_DEL_PROMPT_PREFIX) ||
            interaction.customId.startsWith(this.BTN_REM_DEL_CONFIRM_PREFIX) ||
            interaction.customId.startsWith(this.BTN_REM_DEL_CANCEL_PREFIX)) {
            console.log(`[SekaiVirtualLiveBot] Got button click: ${interaction.customId}`);
            await this.handleReminderButtonClick(interaction);
        } else if (interaction.customId.startsWith(SekaiVirtualLiveBot.VLIVE_NEW_BTN_PREFIX)) {
            console.log(`[SekaiVirtualLiveBot] Got button click: ${interaction.customId}`);
            await interaction.deferReply({ ephemeral: true });
            const info = SekaiVirtualLiveBot.deserializeVliveButton(interaction.customId);
            await this.showVirtualLives(interaction, info.region, info.vliveId);
        } else if (interaction.customId.startsWith(SekaiVirtualLiveBot.VLIVE_BTN_VIEW_SCHEDULE_PREFIX)) {
            console.log(`[SekaiVirtualLiveBot] Got button click: ${interaction.customId}`);
            await interaction.deferReply({ ephemeral: true });
            const fields = interaction.message.embeds[0].fields;
            const region = fields[fields.length - 1].value;
            const selectedId = parseInt(interaction.customId.substring(SekaiVirtualLiveBot.VLIVE_BTN_VIEW_SCHEDULE_PREFIX.length));
            await this.showSchedules(interaction, region, selectedId);
        } else if (interaction.customId.startsWith(SekaiVirtualLiveBot.SCHEDULE_BTN_CREATE_PREFIX)) {
            console.log(`[SekaiVirtualLiveBot] Got button click: ${interaction.customId}`);
            await this.handleCreateScheduleButtonClick(interaction);
        }
    }

    async handleCreateScheduleButtonClick(interaction: ButtonInteraction): Promise<void> {
        const serializedStr = interaction.customId.substring(SekaiVirtualLiveBot.SCHEDULE_BTN_CREATE_PREFIX.length);
        const scheduleInfo = SekaiVirtualLiveBot.deserializeSchedule(serializedStr);
        let vlive = this.cache!.getVliveById(scheduleInfo.region, scheduleInfo.vliveId);
        if (vlive === null) {
            await this.cache!.syncCacheForRegion(scheduleInfo.region);
            vlive = this.cache!.getVliveById(scheduleInfo.region, scheduleInfo.vliveId);
            if (vlive === null) {
                await interaction.reply({
                    embeds: [this.buildErrorEmbed("Virtual Live not found", "Selected Virtual Live not found for the ${scheduleInfo.region} server. It may have ended already.")]
                });
                return;
            }
        }

        const minuteInput = new TextInputBuilder()
            .setCustomId(SekaiVirtualLiveBot.SCHEDULE_MODAL_INPUT_MINUTES)
            .setLabel("How many minutes before to remind?")
            .setStyle(TextInputStyle.Short)
            .setValue("5")
            .setMinLength(1)
            .setMaxLength(2)
            .setRequired(true);
        const row = new ActionRowBuilder().addComponents(minuteInput) as ActionRowBuilder<TextInputBuilder>;

        const modal = new ModalBuilder()
            .setCustomId(`${SekaiVirtualLiveBot.SCHEDULE_MODAL_PREFIX}${serializedStr}`)
            .setTitle("Creating new Virtual Live reminder")
            .addComponents(row);

        await interaction.showModal(modal);
    }

    async handleStringSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
        console.log(`[SekaiVirtualLiveBot] Got string select menu: ${interaction.customId}`);
        const id = interaction.customId;
        if (id == SekaiVirtualLiveBot.VLIVE_SELECT) {
            await interaction.deferUpdate();
            await this.handleVliveSelection(interaction);
            return;
        } else if (id === SekaiVirtualLiveBot.SCHEDULE_SELECT) {
            await interaction.deferUpdate();
            await this.handleScheduleSelection(interaction);
            return;
        }
    }

    async handleVliveSelection(interaction: StringSelectMenuInteraction) {
        const selectedId = parseInt(interaction.values[0]);
        const fields = interaction.message.embeds[0].fields;
        const region = fields[fields.length - 1].value;
        await this.showVirtualLives(interaction, region, selectedId);
    }

    async handleScheduleSelection(interaction: StringSelectMenuInteraction) {
        const selectedStr = interaction.values[0];
        const info = SekaiVirtualLiveBot.deserializeSchedule(selectedStr);
        await this.showSchedules(interaction, info.region, info.vliveId, info.scheduleId);
    }

    async showVirtualLives(interaction: ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction, region: string, currentId: number | null = null): Promise<void> {
        if (!this.cache!.doesRegionExist(region)) {
            console.error(`[SekaiVirtualLiveBot] showVirtualLives() unknown region: ${region}`);
            return;
        }

        if (this.cache!.getSortedVlives(region) === null) {
            console.log(`[SekaiVirtualLiveBot] showVirtualLives() empty cache for region ${region}, attempting to update`);
            await this.refreshVirtualLive(region);
            if (this.cache!.getSortedVlives(region) === null) {
                console.error(`[SekaiVirtualLiveBot] showVirtualLives() empty cache for region ${region} and no new virtual lives found`);
                const newEmbed = this.buildErrorEmbed("No Virtual Lives found", `No current or future Virtual Lives found for the ${region} server.`);
                await interaction.editReply({
                    embeds: [newEmbed]
                });
                return;
            }
        }

        const currentDate = new Date();
        let sortedVlives = this.cache!.getSortedVlives(region)!;
        sortedVlives = SekaiVirtualLiveBot.removePastVlives(currentDate, sortedVlives);
        let selectedVlive: VirtualLive;
        if (currentId === null || this.cache!.getVliveById(region, currentId) === null) {
            selectedVlive = sortedVlives[0];
        } else {
            selectedVlive = this.cache!.getVliveById(region, currentId)!;
            if (selectedVlive.endAt < currentDate) {
                selectedVlive = sortedVlives[0];
            }
        }

        const vliveEmbed = new EmbedBuilder()
            .setTitle(selectedVlive.name)
            .addFields(
                { name: "Starts at:", value: SekaiVirtualLiveBot.createDiscordTimestamp(selectedVlive.startAt, TimestampStyles.LongDateTime)},
                { name: "Ends at:", value: SekaiVirtualLiveBot.createDiscordTimestamp(selectedVlive.endAt, TimestampStyles.LongDateTime)},
                { name: "Region:", value: region}
            )
            .setColor(0x86CECB);

        const btnCreate = new ButtonBuilder()
            .setCustomId(`${SekaiVirtualLiveBot.VLIVE_BTN_VIEW_SCHEDULE_PREFIX}${selectedVlive.id}`)
            .setLabel("View Schedules")
            .setStyle(ButtonStyle.Primary);
        const buttonRow = new ActionRowBuilder().addComponents(btnCreate) as ActionRowBuilder<ButtonBuilder>;

        const selectOptions: StringSelectMenuOptionBuilder[] = [];
        for (const vlive of sortedVlives) {
            selectOptions.push(new StringSelectMenuOptionBuilder()
                .setLabel(vlive.name)
                .setDescription(SekaiVirtualLiveBot.formatRelativeDifference(vlive.startAt))
                .setDefault(vlive.id === selectedVlive.id)
                .setValue(vlive.id.toString())
            );
        }
        const vliveSelect = new StringSelectMenuBuilder()
            .setCustomId(SekaiVirtualLiveBot.VLIVE_SELECT)
            .addOptions(selectOptions);
        const selectRow = new ActionRowBuilder().addComponents(vliveSelect)  as ActionRowBuilder<StringSelectMenuBuilder>;
        await interaction.editReply({
            embeds: [vliveEmbed],
            components: [buttonRow, selectRow]
        });
    }

    async showSchedules(interaction: ButtonInteraction | StringSelectMenuInteraction, region: string, vliveId: number, currentScheduleId: number | null = null): Promise<void> {
        if (!this.cache!.doesRegionExist(region)) {
            console.error(`[SekaiVirtualLiveBot] showSchedules() unknown region: ${region}`);
            return;
        }

        if (this.cache!.getSortedSchedules(region, vliveId) === null) {
            console.log(`[SekaiVirtualLiveBot] showSchedules() empty cache for region ${region} and virtual live ID ${vliveId}, attempting to update`);
            await this.refreshVirtualLive(region);
            if (this.cache!.getSortedSchedules(region, vliveId) === null) {
                console.error(`[SekaiVirtualLiveBot] showSchedules() empty cache for region ${region} and virtual live ID ${vliveId}`);
                const newEmbed = this.buildErrorEmbed("Virtual Live could not be found", `Could not find that Virtual Live for the ${region} server. It may have finished already.`);
                await interaction.editReply({
                    embeds: [newEmbed]
                });
                return;
            }
        }

        const currentDate = new Date();
        let sortedSchedules = this.cache!.getSortedSchedules(region, vliveId)!;
        sortedSchedules = SekaiVirtualLiveBot.removePastSchedules(currentDate, sortedSchedules);
        let selectedSchedule = sortedSchedules[0];
        if (currentScheduleId !== null) {
            selectedSchedule = this.cache!.getScheduleById(region, vliveId, currentScheduleId)!;
            if (selectedSchedule.startAt < currentDate) {
                selectedSchedule = sortedSchedules[0];
            }
        }
        const selectedVlive = this.cache!.getVliveById(region, vliveId)!;
        const lastSchedule = sortedSchedules[sortedSchedules.length - 1];

        const scheduleEmbed = new EmbedBuilder()
            .setTitle(selectedVlive.name)
            .addFields(
                { name: "Starts at:", value: SekaiVirtualLiveBot.createDiscordTimestamp(selectedSchedule.startAt, TimestampStyles.LongDateTime)},
                { name: "Ends at:", value: SekaiVirtualLiveBot.createDiscordTimestamp(selectedSchedule.endAt, TimestampStyles.LongDateTime)},
                { name: "Showing Sequence:", value: `${selectedSchedule.seq} of ${lastSchedule.seq}` },
                { name: "Region:", value: region}
            )
            .setColor(0x86CECB);

        const btnCreate = new ButtonBuilder()
            .setCustomId(`${SekaiVirtualLiveBot.SCHEDULE_BTN_CREATE_PREFIX}${SekaiVirtualLiveBot.serializeSchedule(region, selectedSchedule)}`)
            .setLabel("Create Reminder")
            .setStyle(ButtonStyle.Primary);
        const buttonRow = new ActionRowBuilder().addComponents(btnCreate) as ActionRowBuilder<ButtonBuilder>;

        const selectOptions: StringSelectMenuOptionBuilder[] = [];
        for (const schedule of sortedSchedules) {
            const day = moment(schedule.startAt);
            const formattedStr = day.format("ddd, MMM D, h:mm A ZZ");

            selectOptions.push(new StringSelectMenuOptionBuilder()
                .setLabel(`Showing #${schedule.seq}`)
                .setDescription(formattedStr)
                .setDefault(schedule.id === selectedSchedule.id)
                .setValue(SekaiVirtualLiveBot.serializeSchedule(region, schedule))
            );
        }
        const vliveSelect = new StringSelectMenuBuilder()
            .setCustomId(SekaiVirtualLiveBot.SCHEDULE_SELECT)
            .addOptions(selectOptions);
        const selectRow = new ActionRowBuilder().addComponents(vliveSelect) as ActionRowBuilder<StringSelectMenuBuilder>;
        await interaction.editReply({
            embeds: [scheduleEmbed],
            components: [buttonRow, selectRow]
        });
    }

    async handleReminderButtonClick(interaction: ButtonInteraction<CacheType>): Promise<void> {
        const interactUser = interaction.user.id;
        const slashUser = interaction.message.interaction!.user.id;
        if (interactUser !== slashUser) {
            await interaction.update("");
            return;
        }

        const currentPos = this.deserializeListString(interaction.message.embeds[0].title!);
        let newUpdate: WebhookEditMessageOptions | null = null;
        if (interaction.customId === this.BTN_REM_PREV) {
            newUpdate = await this.buildReminderList(interactUser, interaction.guildId!, currentPos - 1);
        } else if (interaction.customId === this.BTN_REM_NEXT) {
            newUpdate = await this.buildReminderList(interactUser, interaction.guildId!, currentPos + 1);
        } else if (interaction.customId.startsWith(this.BTN_REM_DEL_PROMPT_PREFIX)) {
            newUpdate = await this.handleDeletePrompt(interaction);
        }  else if (interaction.customId.startsWith(this.BTN_REM_DEL_CONFIRM_PREFIX)) {
            await this.handleDeleteConfirm(interaction, currentPos);
        } else if (interaction.customId.startsWith(this.BTN_REM_DEL_CANCEL_PREFIX)) {
            newUpdate = await this.handleDeleteCancel(interaction);
        }

        if (newUpdate !== null) {
            await interaction.update(newUpdate);
        }

        return;
    }

    async sendNewLivesMessage(newVlivesInRegion: RegionToNewVliveCount): Promise<void> {
        if (SekaiVirtualLiveBot.instance.config!.newLivesChannel === null || SekaiVirtualLiveBot.instance.config!.newLivesChannel.trim().length === 0) {
            return;
        }

        console.log("[SekaiVirtualLiveBot] sendNewLivesMessage()");

        let msg: string | null = null;
        if (SekaiVirtualLiveBot.instance.config!.newMessageContent !== null && SekaiVirtualLiveBot.instance.config!.newMessageContent.trim().length > 0) {
            msg = SekaiVirtualLiveBot.instance.config!.newMessageContent;
        }

        let description = "";
        const btnRows: ActionRowBuilder<ButtonBuilder>[] = [];
        let currentRow: ActionRowBuilder<ButtonBuilder> = new ActionRowBuilder();
        for (const region in newVlivesInRegion.regions) {
            const newLives = newVlivesInRegion.regions[region];
            if (newLives.newCount === 0 || newLives.vliveId === null) {
                continue;
            }

            const str = `**${region}:** ${newLives.newCount} new\n\n`;
            description += str;

            if (currentRow.components.length >= 3) {
                btnRows.push(currentRow);
                currentRow = new ActionRowBuilder();
            }

            const btnId = SekaiVirtualLiveBot.serializeVliveButton(region, newLives.vliveId);
            currentRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(btnId)
                    .setLabel(region)
                    .setStyle(ButtonStyle.Primary)
            );
        }

        if (description === "") {
            return;
        }

        btnRows.push(currentRow);
        description += "*Click a server region button below to view the new Virtual Lives and create reminders!*";

        const embed = new EmbedBuilder()
            .setTitle("Found new Virtual Lives in the following regions")
            .setDescription(description)
            .setColor(0x137A7F);

        const channel = SekaiVirtualLiveBot.instance.client!.channels.cache.get(SekaiVirtualLiveBot.instance.config!.newLivesChannel) as TextChannel;
        const newMsgOptions: MessageCreateOptions = {
            embeds: [embed],
            components: btnRows
        };
        if (msg !== null) {
            newMsgOptions.content = msg;
        }

        await channel.send(newMsgOptions);
    }

    async refreshVirtualLiveJob(job: Job): Promise<void> {
        try {
            await SekaiVirtualLiveBot.instance.refreshVirtualLive(null);
        } catch (error) {
            console.error(`[SekaiVirtualLiveBot] Error during refreshVirtualLiveJob(): ${error}`);
            if (error instanceof Error || typeof(error) === "string") {
                job.fail(error);
            } else {
                job.fail(`Unknown error type: ${error}`);
            }
        }
    }

    async refreshVirtualLive(region: string | null = null): Promise<void> {
        const newObj = await SekaiVirtualLiveBot.instance.cache!.refreshCache(region);
        if (newObj.newFound) {
            await this.sendNewLivesMessage(newObj);
        }
    }

    async handleReminderJob(job: Job): Promise<void> {
        try {
            if (job.attrs.data === undefined || job.attrs.lastRunAt === undefined) {
                throw new Error(`[${SekaiVirtualLiveBot.instance.CLASS_NAME}] Bad job data: ${job.toJSON()}`);
            }

            const data = job.attrs.data as ReminderJobData;
            const embed = await SekaiVirtualLiveBot.instance.buildReminderEmbed(
                SekaiVirtualLiveBot.instance.REMINDER_TRIGGERED_TITLE, job.attrs.lastRunAt, data, 0xFFFFFF);
            const channel = await SekaiVirtualLiveBot.instance.client!.channels.fetch(data.channelId);
            const user = await SekaiVirtualLiveBot.instance.client!.users.fetch(data.userId);
            if (channel === null || !channel.isTextBased()) {
                const error = `[${SekaiVirtualLiveBot.instance.CLASS_NAME}] Channel ID is unexpected: ${data.channelId}`;
                throw new Error(error);
            }

            await channel.send({
                content: user.toString(),
                embeds: [embed]
            });

            await job.remove();
        } catch (error) {
            const errStr = `[${SekaiVirtualLiveBot.instance.CLASS_NAME}] Failed to finish reminder job: ${error}`;
            console.error(errStr);
            job.fail(errStr);
        }
    }

    static removePastSchedules(currentDate: Date, sortedSchedules: VirtualLiveSchedule[]): VirtualLiveSchedule[] {
        const newArr: VirtualLiveSchedule[] = [];
        for (const schedule of sortedSchedules) {
            if (schedule.startAt < currentDate) {
                continue;
            }

            newArr.push(schedule);
        }

        return newArr;
    }

    static removePastVlives(currentDate: Date, sortedVlives: VirtualLive[]): VirtualLive[] {
        const newArr: VirtualLive[] = [];
        for (const vlive of sortedVlives) {
            if (vlive.endAt < currentDate) {
                continue;
            }

            newArr.push(vlive);
        }

        return newArr;
    }

    static formatRelativeDifference(date: Date): string {
        const str = moment(date).fromNow(true);
        return "In about " + str;
    }

    static subtractMinutes(date: Date, minutes: number): Date {
        return moment(date).subtract(minutes, "minutes").toDate();
    }

    static createDiscordTimestamp(date: Date, style: TimestampStylesString) {
        return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
    }

    static serializeSchedule(region: string, schedule: VirtualLiveSchedule): string {
        return `${region}_${schedule.virtualLiveId}_${schedule.id}`;
    }

    static deserializeSchedule(input: string): ScheduleInfo {
        const arr = input.split("_");
        return {
            region: arr[0],
            vliveId: parseInt(arr[1]),
            scheduleId: parseInt(arr[2])
        };
    }

    static serializeVliveButton(region: string, vliveId: number): string {
        return `${SekaiVirtualLiveBot.VLIVE_NEW_BTN_PREFIX}${region}__${vliveId}`;
    }

    static deserializeVliveButton(input: string): VliveButtonInfo {
        const arr = input.split("__");
        return {
            region: arr[1],
            vliveId: parseInt(arr[2])
        };
    }
}

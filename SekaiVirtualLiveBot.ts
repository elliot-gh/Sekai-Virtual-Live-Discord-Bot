import Agenda, { Job } from "agenda";
import { GatewayIntentBits, SlashCommandBuilder, ContextMenuCommandBuilder, CommandInteraction, CacheType,
    Client, ButtonInteraction, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, TextChannel,
    StringSelectMenuBuilder, ChatInputCommandInteraction, TimestampStylesString,
    TimestampStyles, StringSelectMenuInteraction, MessageCreateOptions, StringSelectMenuOptionBuilder,
    TextInputBuilder, TextInputStyle, ModalBuilder, ModalSubmitInteraction, InteractionUpdateOptions, ColorResolvable, InteractionEditReplyOptions, AutocompleteInteraction, ApplicationCommandOptionChoiceData } from "discord.js";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import timezone from "dayjs/plugin/timezone";
import utc from "dayjs/plugin/utc";
dayjs.extend(relativeTime);
dayjs.extend(timezone);
dayjs.extend(utc);
import Fuse from "fuse.js";
import { AbstractReminderBot } from "../../reminders/AbstractReminderBot";
import { createAgenda } from "../../reminders/ReminderUtils";
import { VirtualLive, VirtualLiveSchedule } from "./VirtualLiveInterfaces";
import { SekaiVirtualLiveConfig } from "./SekaiVirtualLiveConfig";
import { MongoVirtualLive } from "./MongoVirtualLive";
import { RegionToNewVliveCount, VirtualLiveCache } from "./VirtualLiveCache";
import { ReminderJobData } from "../../reminders/ReminderJobData";

// FIXME: workaround for Intl.supportedValuesOf not being defined in typescript 5.0.4
// remove in typescript 5.1?
// eslint-disable-next-line @typescript-eslint/no-namespace
declare namespace Intl {
    type Key = "calendar" | "collation" | "currency" | "numberingSystem" | "timeZone" | "unit";

    // eslint-disable-next-line no-unused-vars
    function supportedValuesOf(input: Key): string[];
}

type ScheduleInfo = {
    region: string,
    vliveId: number,
    scheduleId: number
}

type VliveButtonInfo = {
    region: string,
    vliveId: number
};

type VirtualLiveReminderData = {
    region: string,
    vliveId: number,
    scheduleId: number
};

type Timezone = {
    name: string
};

export class SekaiVirtualLiveBot extends AbstractReminderBot<VirtualLiveReminderData> {
    private static readonly SUBCMD_CREATE = "create";
    private static readonly SUBCMD_LIST = "my-reminders";
    private static readonly SUBCMD_SET_TZ = "timezone-set";
    private static readonly SUBCMD_GET_TZ = "timezone-get";
    private static readonly AGENDA_JOB_REMINDER = "agendaJobVirtualLiveReminder";
    private static readonly AGENDA_JOB_REFRESH = "agendaJobVirtualLiveRefresh";
    private static readonly VLIVE_NEW_BTN_PREFIX = "SekaiVliveBot_newVliveBtn__";
    private static readonly VLIVE_SELECT = "SekaiVliveBot_vliveSelect";
    private static readonly VLIVE_BTN_VIEW_SCHEDULE_PREFIX = "SekaiVliveBot_BtnVliveViewSchedules_";
    private static readonly SCHEDULE_SELECT = "SekaiVliveBot_scheduleSelect";
    private static readonly SCHEDULE_BTN_CREATE_PREFIX = "SekaiVliveBot_scheduleBtnCreate_";
    private static readonly SCHEDULE_MODAL_PREFIX = "SekaiVliveBot_scheduleModal_";
    private static readonly SCHEDULE_MODAL_INPUT_MINUTES = "SekaiVliveBot_inputMinutes";
    private static readonly OPT_TZ = "timezone";

    protected readonly BTN_REM_PREV = "SekaiVliveBot_btnPrev";
    protected readonly BTN_REM_NEXT = "SekaiVliveBot_btnNext";
    protected readonly BTN_REM_DEL_PROMPT_PREFIX = "SekaiVliveBot_btnDeletePrompt__";
    protected readonly BTN_REM_DEL_CONFIRM_PREFIX = "SekaiVliveBot_btnDeleteConfirm__";
    protected readonly BTN_REM_DEL_CANCEL_PREFIX = "SekaiVliveBot_btnDeleteCancel__";
    protected readonly REMINDER_TYPE = "Virtual Live reminder";
    protected readonly REMINDER_TYPE_TITLE = "Virtual Live Reminder";
    protected readonly REMINDER_TRIGGERED_TITLE = "Project Sekai Virtual Live Starting Soon";
    protected client: Client | null = null;
    protected agenda: Agenda | null = null;

    private static instance: SekaiVirtualLiveBot;
    private readonly intents: GatewayIntentBits[];
    private readonly commands: (SlashCommandBuilder | ContextMenuCommandBuilder)[];
    private readonly slashReminder: SlashCommandBuilder;
    private readonly config: SekaiVirtualLiveConfig | null;
    private cache: VirtualLiveCache | null;
    private timezoneSearchArr: Timezone[];
    private timezoneDict: { [key: string]: boolean } = {};
    private timezoneFuse!: Fuse<Timezone>;

    constructor() {
        super("SekaiVirtualLiveBot", import.meta);

        this.config = this.readYamlConfig<SekaiVirtualLiveConfig>("config.yaml");
        this.intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
        this.slashReminder = new SlashCommandBuilder()
            .setName("vlive")
            .setDescription("Set, delete, or view your Project Sekai Virtual Live reminders.")
            .addSubcommand(subcommand =>
                subcommand
                    .setName(SekaiVirtualLiveBot.SUBCMD_LIST)
                    .setDescription("Lists your Virtual Live reminders, which also allows you to delete them."))
            .addSubcommand(subcommand =>
                subcommand
                    .setName(SekaiVirtualLiveBot.SUBCMD_GET_TZ)
                    .setDescription("Get your timezone for Virtual Live times."))
            .addSubcommand(subcommand =>
                subcommand
                    .setName(SekaiVirtualLiveBot.SUBCMD_SET_TZ)
                    .setDescription("Set your timezone for Virtual Live times.")
                    .addStringOption(option =>
                        option
                            .setName(SekaiVirtualLiveBot.OPT_TZ)
                            .setDescription("Your timezone.")
                            .setAutocomplete(true)
                            .setRequired(true)
                    )
            ) as SlashCommandBuilder;
        this.commands = [this.slashReminder];
        this.cache = null;
        this.timezoneSearchArr = [];

        if (SekaiVirtualLiveBot.instance !== undefined) {
            return;
        }
        SekaiVirtualLiveBot.instance = this;
    }

    async preInit(): Promise<string | null> {
        try {
            if (this.config === null) {
                throw new Error("this.config is null");
            }

            this.agenda = await createAgenda(this.config.mongoDb.url, this.config.mongoDb.user,
                this.config.mongoDb.password, this.config.mongoDb.agendaCollection);
            await MongoVirtualLive.init(this.config);
            this.cache = new VirtualLiveCache(this.config);
            this.slashReminder.addSubcommand(subcommand =>
                subcommand
                    .setName(SekaiVirtualLiveBot.SUBCMD_CREATE)
                    .setDescription("View current Virtual Lives schedules and create reminders.")
                    .addStringOption(option => {
                        option.setName("region")
                            .setDescription("The server region you want to view schedules for.")
                            .setRequired(true);
                        for (const region in this.config?.sekaiServers) {
                            option.addChoices({ name: region, value: region });
                        }

                        return option;
                    })
            );

            for (const timezone of Intl.supportedValuesOf("timeZone")) {
                this.timezoneSearchArr.push({ name: timezone });
                this.timezoneDict[timezone] = true;
            }

            this.timezoneFuse = new Fuse(this.timezoneSearchArr, {
                keys: ["name"],
                isCaseSensitive: false,
                shouldSort: true
            });

            this.agenda.define(SekaiVirtualLiveBot.AGENDA_JOB_REMINDER, this.handleReminderJob);
            this.agenda.define(SekaiVirtualLiveBot.AGENDA_JOB_REFRESH, this.refreshVirtualLiveJob);

            return null;
        } catch (error) {
            const errMsg = `Error in init(): ${error}`;
            this.logger.error(errMsg);
            return errMsg;
        }
    }

    async processCommand(interaction: CommandInteraction<CacheType>): Promise<void> {
        if (!interaction.isChatInputCommand()) {
            return;
        }

        if (this.client === null || this.client.user === null) {
            this.logger.error("this.client or this.client.user is null");
            return;
        } else if (interaction.user.id === this.client.user.id) {
            return;
        }

        try {
            this.logger.info(`got interaction: ${interaction}`);
            if (interaction.commandName === this.slashReminder.name) {
                switch(interaction.options.getSubcommand()) {
                    case SekaiVirtualLiveBot.SUBCMD_CREATE: {
                        const region = interaction.options.getString("region");
                        if (region === null) {
                            await interaction.reply({
                                content: "Invalid region, this should not happen. Contact the bot owner.",
                                ephemeral: true
                            });
                            return;
                        }

                        await interaction.deferReply({ ephemeral: true });
                        await this.showVirtualLives(interaction, region, null);
                        break;
                    }
                    case SekaiVirtualLiveBot.SUBCMD_LIST:
                        await this.handleSlashList(interaction);
                        break;
                    case SekaiVirtualLiveBot.SUBCMD_SET_TZ:
                        await this.handleSlashSetTz(interaction);
                        break;
                    case SekaiVirtualLiveBot.SUBCMD_GET_TZ:
                        await this.handleSlashGetTz(interaction);
                        break;
                    default:
                        this.logger.warn(`Unknown subcommand: ${interaction.options.getSubcommand()}`);
                        break;
                }
            }
        } catch (error) {
            this.logger.error(`Got error: ${error}`);
        }
    }

    async useClient(client: Client<boolean>): Promise<void> {
        if (this.agenda === null) {
            throw new Error("agenda is null");
        } else if (this.config === null) {
            throw new Error("config is null");
        }

        this.client = client;
        await this.agenda.start();
        await this.agenda.every(`${this.config.refreshIntervalHours} hours`, SekaiVirtualLiveBot.AGENDA_JOB_REFRESH);
        client.on("interactionCreate", async (interaction) => {
            if (client.user === null) {
                this.logger.warn("client.user is null");
                return;
            }

            if (interaction.user.id === client.user.id) {
                return;
            }

            if (interaction.isButton()) {
                await this.handleButtonClick(interaction);
            } else if (interaction.isStringSelectMenu()) {
                await this.handleStringSelectMenu(interaction);
            } else if (interaction.isModalSubmit()) {
                await this.handleModalSubmit(interaction);
            } else if (interaction.isAutocomplete()) {
                if (interaction.commandName !== this.slashReminder.name) {
                    return;
                }

                void this.handleAutoComplete(interaction);
            }
        });
    }

    private async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
        if (!interaction.customId.startsWith(SekaiVirtualLiveBot.SCHEDULE_MODAL_PREFIX)) {
            return;
        }

        if (this.cache === null) {
            throw new Error("cache is null");
        } else if (interaction.channelId === null) {
            throw new Error("interaction.channelId is null");
        }

        this.logger.info(`Got modal submit: ${interaction.customId}`);
        await interaction.deferReply({ ephemeral: true });

        const serializedStr = interaction.customId.substring(SekaiVirtualLiveBot.SCHEDULE_MODAL_PREFIX.length);
        const scheduleInfo = SekaiVirtualLiveBot.deserializeSchedule(serializedStr);
        let vlive = this.cache.getVliveById(scheduleInfo.region, scheduleInfo.vliveId);
        if (vlive === null) {
            this.logger.info(`handleModalSubmit() could not find virtual live with ID ${scheduleInfo.vliveId} for region ${scheduleInfo.region}, attempting to update`);
            await this.refreshVirtualLive(scheduleInfo.region);
            vlive = this.cache.getVliveById(scheduleInfo.region, scheduleInfo.vliveId);
            if (vlive === null) {
                this.logger.info(`handleModalSubmit() could not find virtual live with ID ${scheduleInfo.vliveId} for region ${scheduleInfo.region}, returning`);
                const newEmbed = this.buildErrorEmbed("Virtual Live not found", `Selected Virtual Live not found for the ${scheduleInfo.region} server. It may have ended already.`);
                await interaction.editReply({
                    embeds: [newEmbed]
                });
                return;
            }
        }

        const schedule = this.cache.getScheduleById(scheduleInfo.region, scheduleInfo.vliveId, scheduleInfo.scheduleId);
        if (schedule === null) {
            this.logger.error(`handleCreateScheduleButtonClick() could not find schedule ${scheduleInfo.scheduleId} for region ${scheduleInfo.region}, returning`);
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

        const jobData: ReminderJobData<VirtualLiveReminderData> = {
            userId: interaction.user.id,
            channelId: interaction.channelId,
            guildId: interaction.guildId ?? "@me",
            reminderTime: remindTime,
            data: {
                vliveId: vlive.id,
                scheduleId: schedule.id,
                region: scheduleInfo.region
            }
        };

        const embed = await this.createReminder(jobData, SekaiVirtualLiveBot.AGENDA_JOB_REMINDER);
        await interaction.editReply({ embeds: [embed] });
    }

    protected async handleButtonClick(interaction: ButtonInteraction<CacheType>): Promise<void> {
        if (interaction.customId === this.BTN_REM_PREV ||
            interaction.customId === this.BTN_REM_NEXT ||
            interaction.customId.startsWith(this.BTN_REM_DEL_PROMPT_PREFIX) ||
            interaction.customId.startsWith(this.BTN_REM_DEL_CONFIRM_PREFIX) ||
            interaction.customId.startsWith(this.BTN_REM_DEL_CANCEL_PREFIX)) {
            this.logger.info(`Got button click: ${interaction.customId}`);
            await this.handleReminderButtonClick(interaction);
        } else if (interaction.customId.startsWith(SekaiVirtualLiveBot.VLIVE_NEW_BTN_PREFIX)) {
            this.logger.info(`Got button click: ${interaction.customId}`);
            await interaction.deferReply({ ephemeral: true });
            const info = SekaiVirtualLiveBot.deserializeVliveButton(interaction.customId);
            await this.showVirtualLives(interaction, info.region, info.vliveId);
        } else if (interaction.customId.startsWith(SekaiVirtualLiveBot.VLIVE_BTN_VIEW_SCHEDULE_PREFIX)) {
            this.logger.info(`Got button click: ${interaction.customId}`);
            await interaction.deferReply({ ephemeral: true });
            const fields = interaction.message.embeds[0].fields;
            const region = fields[fields.length - 1].value;
            const selectedId = parseInt(interaction.customId.substring(SekaiVirtualLiveBot.VLIVE_BTN_VIEW_SCHEDULE_PREFIX.length));
            await this.showSchedules(interaction, region, selectedId);
        } else if (interaction.customId.startsWith(SekaiVirtualLiveBot.SCHEDULE_BTN_CREATE_PREFIX)) {
            this.logger.info(`Got button click: ${interaction.customId}`);
            await this.handleCreateScheduleButtonClick(interaction);
        }
    }

    private async handleCreateScheduleButtonClick(interaction: ButtonInteraction): Promise<void> {
        if (this.cache === null) {
            throw new Error("cache is null");
        }

        const serializedStr = interaction.customId.substring(SekaiVirtualLiveBot.SCHEDULE_BTN_CREATE_PREFIX.length);
        const scheduleInfo = SekaiVirtualLiveBot.deserializeSchedule(serializedStr);
        let vlive = this.cache.getVliveById(scheduleInfo.region, scheduleInfo.vliveId);
        if (vlive === null) {
            await this.cache.syncCacheForRegion(scheduleInfo.region);
            vlive = this.cache.getVliveById(scheduleInfo.region, scheduleInfo.vliveId);
            if (vlive === null) {
                await interaction.reply({
                    embeds: [this.buildErrorEmbed("Virtual Live not found", `Selected Virtual Live not found for the ${scheduleInfo.region} server. It may have ended already.`)]
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

    private async handleStringSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
        this.logger.info(`Got string select menu: ${interaction.customId}`);
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

    private async handleVliveSelection(interaction: StringSelectMenuInteraction) {
        const selectedId = parseInt(interaction.values[0]);
        const fields = interaction.message.embeds[0].fields;
        const region = fields[fields.length - 1].value;
        await this.showVirtualLives(interaction, region, selectedId);
    }

    private async handleScheduleSelection(interaction: StringSelectMenuInteraction) {
        const selectedStr = interaction.values[0];
        const info = SekaiVirtualLiveBot.deserializeSchedule(selectedStr);
        await this.showSchedules(interaction, info.region, info.vliveId, info.scheduleId);
    }

    private async showVirtualLives(interaction: ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction, region: string, currentId: number | null = null): Promise<void> {
        if (this.cache === null) {
            throw new Error("cache is null");
        }

        if (!this.cache.doesRegionExist(region)) {
            this.logger.error(`showVirtualLives() unknown region: ${region}`);
            return;
        }

        let sortedVlives = this.cache.getSortedVlives(region);
        if (sortedVlives === null) {
            this.logger.info(`showVirtualLives() empty cache for region ${region}, attempting to update`);
            await this.refreshVirtualLive(region);
            sortedVlives = this.cache.getSortedVlives(region);
            if (sortedVlives === null) {
                this.logger.error(`showVirtualLives() empty cache for region ${region} and no new virtual lives found`);
                const newEmbed = this.buildErrorEmbed("No Virtual Lives found", `No current or future Virtual Lives found for the ${region} server.`);
                await interaction.editReply({
                    embeds: [newEmbed]
                });
                return;
            }
        }

        const currentDate = new Date();
        sortedVlives = SekaiVirtualLiveBot.removePastVlives(currentDate, sortedVlives);
        let selectedVlive: VirtualLive | null;
        if (currentId === null || this.cache.getVliveById(region, currentId) === null) {
            selectedVlive = sortedVlives[0];
        } else {
            selectedVlive = this.cache.getVliveById(region, currentId);
            if (selectedVlive === null) {
                selectedVlive = sortedVlives[0];
            } else if (selectedVlive.endAt < currentDate) {
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

    private async showSchedules(interaction: ButtonInteraction | StringSelectMenuInteraction, region: string, vliveId: number, currentScheduleId: number | null = null): Promise<void> {
        if (this.cache === null) {
            throw new Error("cache is null");
        }

        if (!this.cache.doesRegionExist(region)) {
            this.logger.error(`showSchedules() unknown region: ${region}`);
            return;
        }

        let sortedSchedules = this.cache.getSortedSchedules(region, vliveId);
        if (sortedSchedules === null) {
            this.logger.info(`showSchedules() empty cache for region ${region} and virtual live ID ${vliveId}, attempting to update`);
            await this.refreshVirtualLive(region);
            sortedSchedules = this.cache.getSortedSchedules(region, vliveId);
            if (sortedSchedules === null) {
                this.logger.error(`showSchedules() empty cache for region ${region} and virtual live ID ${vliveId}`);
                const newEmbed = this.buildErrorEmbed("Virtual Live could not be found", `Could not find that Virtual Live for the ${region} server. It may have finished already.`);
                await interaction.editReply({
                    embeds: [newEmbed]
                });
                return;
            }
        }

        const currentDate = new Date();

        sortedSchedules = SekaiVirtualLiveBot.removePastSchedules(currentDate, sortedSchedules);
        let selectedSchedule = sortedSchedules[0];
        if (currentScheduleId !== null) {
            const selectedById = this.cache.getScheduleById(region, vliveId, currentScheduleId);
            if (selectedById === null) {
                selectedSchedule = sortedSchedules[0];
            } else {
                if (selectedById.startAt < currentDate) {
                    selectedSchedule = sortedSchedules[0];
                } else {
                    selectedSchedule = selectedById;
                }
            }
        }

        const selectedVlive = this.cache.getVliveById(region, vliveId);
        if (selectedVlive === null) {
            this.logger.error(`showSchedules() could not find Virtual Live with ID ${vliveId}`);
            const newEmbed = this.buildErrorEmbed("Virtual Live could not be found", `Could not find that Virtual Live for the ${region} server. It may have finished already.`);
            await interaction.editReply({
                embeds: [newEmbed]
            });
            return;
        }

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

        const userId = interaction.user.id;
        let userTimezone: string | null;
        try {
            userTimezone = await MongoVirtualLive.getUserTimezone(userId);
        } catch (error) {
            this.logger.error(`showSchedules() failed to get user timezone for user ${userId}: ${error}`);
            userTimezone = null;
        }

        const selectOptions: StringSelectMenuOptionBuilder[] = [];
        for (const schedule of sortedSchedules) {
            const day = dayjs(schedule.startAt);
            let formattedStr: string;
            if (userTimezone === null) {
                if (this.config?.defaultTimezone !== null) {
                    formattedStr = day.tz(this.config?.defaultTimezone).format("ddd, MMM D, h:mm A ZZ");
                } else {
                    formattedStr = day.format("ddd, MMM D, h:mm A ZZ");
                }
            } else {
                formattedStr = day.tz(userTimezone).format("ddd, MMM D, h:mm A ZZ");
            }

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
        const editPayload: InteractionEditReplyOptions = {
            embeds: [scheduleEmbed],
            components: [buttonRow, selectRow]
        };

        if (userTimezone === null) {
            editPayload.content = "You have not set your timezone yet, so the drop down subtext is using the system default timezone. "
                + "This may be inconvenient to look through schedules, but does not affect your reminder time. "
                + `Please use \`/${this.slashReminder.name} ${SekaiVirtualLiveBot.SUBCMD_SET_TZ}\` to set it.`;
        }

        await interaction.editReply(editPayload);
    }

    private async handleReminderButtonClick(interaction: ButtonInteraction<CacheType>): Promise<void> {
        if (interaction.message.interaction === null) {
            this.logger.error(`Got null interaction: ${interaction.customId} in handleButtonClick(), skipping`);
            return;
        } else if (interaction.message.embeds.length < 1) {
            this.logger.error(`Got message with no embeds: ${interaction.customId}, skipping`);
            return;
        } else if (interaction.message.embeds[0].title === null) {
            this.logger.error(`Got embed with null title: ${interaction.customId}, skipping`);
            return;
        }

        const interactUser = interaction.user.id;
        const slashUser = interaction.message.interaction.user.id;
        if (interactUser !== slashUser) {
            await interaction.update("");
            return;
        }

        const currentPos = this.deserializeListString(interaction.message.embeds[0].title);
        let newUpdate: InteractionUpdateOptions | null = null;
        if (interaction.customId === this.BTN_REM_PREV) {
            newUpdate = await this.buildReminderList(interactUser, interaction.guildId, currentPos - 1);
        } else if (interaction.customId === this.BTN_REM_NEXT) {
            newUpdate = await this.buildReminderList(interactUser, interaction.guildId, currentPos + 1);
        } else if (interaction.customId.startsWith(this.BTN_REM_DEL_PROMPT_PREFIX)) {
            newUpdate = await this.handleDeletePrompt(interaction);
        }  else if (interaction.customId.startsWith(this.BTN_REM_DEL_CONFIRM_PREFIX)) {
            await this.handleDeleteConfirm(interaction, currentPos);
        } else if (interaction.customId.startsWith(this.BTN_REM_DEL_CANCEL_PREFIX)) {
            newUpdate = await this.handleDeleteCancel(interaction);
        } else {
            this.logger.warn(`Got unknown button interaction: ${interaction.customId} in handleButtonClick(), skipping`);
            return;
        }

        if (newUpdate !== null) {
            await interaction.update(newUpdate);
        }

        return;
    }

    private async handleSlashGetTz(interaction: ChatInputCommandInteraction): Promise<void> {
        this.logger.info(`Got get tz subcmd from ${interaction.user.id}`);

        await interaction.deferReply({ ephemeral: true });
        try {
            const timezoneStr = await MongoVirtualLive.getUserTimezone(interaction.user.id);
            if (timezoneStr === null) {
                await interaction.editReply({
                    embeds: [
                        this.buildErrorEmbed(
                            "No Timezone Set",
                            `You have not set your timezone yet. Please use \`/${this.slashReminder.name} ${SekaiVirtualLiveBot.SUBCMD_SET_TZ}\` to set it.`
                        )
                    ]
                });
                return;
            }

            const timezoneFormatted = SekaiVirtualLiveBot.timezoneStrFormat(timezoneStr);
            this.logger.info(`Got timezone ${timezoneStr} for ${interaction.user.id} (${timezoneFormatted})`);
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle(timezoneStr)
                        .setDescription(timezoneFormatted)
                        .setColor(0x8D8F91)
                ]
            });
        } catch (error) {
            this.logger.error(`Error in handleSlashGetTz(): ${error}`);
            await interaction.editReply({
                embeds: [
                    this.buildErrorEmbed(
                        "Error Getting Timezone",
                        "There was an error getting your timezone. Please try again later."
                    )
                ]
            });
        }
    }

    private async handleSlashSetTz(interaction: ChatInputCommandInteraction): Promise<void> {
        this.logger.info(`Got set tz subcmd from ${interaction.user.id}`);
        const timezoneStr = interaction.options.getString("timezone", true);
        if (!this.timezoneDict[timezoneStr]) {
            await interaction.reply({
                embeds: [
                    this.buildErrorEmbed(
                        "Invalid Timezone",
                        `The timezone ${timezoneStr} is invalid.`
                    )
                ],
                ephemeral: true
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        try {
            const result = await MongoVirtualLive.createOrUpdateUserTimezone(interaction.user.id, timezoneStr);
            this.logger.verbose(`createOrUpdateUserTimezone() result: ${result}`);
            const timezoneFormatted = SekaiVirtualLiveBot.timezoneStrFormat(timezoneStr);
            this.logger.info(`Set timezone ${timezoneStr} for ${interaction.user.id} (${timezoneFormatted})`);
            await interaction.editReply({
                embeds: [
                    new EmbedBuilder()
                        .setTitle("Timezone Set")
                        .setDescription(`Your timezone has been set to ${timezoneStr} (${timezoneFormatted})`)
                        .setColor(0x00FF00)
                ]
            });
        } catch (error) {
            this.logger.error(`Error in handleSlashSetTz(): ${error}`);
            await interaction.editReply({
                embeds: [
                    this.buildErrorEmbed(
                        "Error Setting Timezone",
                        "There was an error setting your timezone. Please try again later."
                    )
                ]
            });
        }
    }

    private static timezoneStrFormat(timezoneStr: string): string {
        const timezoneMinutes = dayjs().utc().tz(timezoneStr).utcOffset();
        const hours = Math.floor(Math.abs(timezoneMinutes) / 60);
        const minutes = Math.abs(timezoneMinutes) % 60;
        const sign = timezoneMinutes < 0 ? "-" : "+";
        const timezoneFormatted = `${sign}${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
        return timezoneFormatted;
    }

    private async handleAutoComplete(interaction: AutocompleteInteraction): Promise<void> {
        let query = interaction.options.getString(SekaiVirtualLiveBot.OPT_TZ);
        // this.logger.info(`Got interaction ${interaction} with query: ${query}`);
        try {
            if (query === null || query.length === 0) {
                query = this.timezoneSearchArr[0].name.charAt(0);
            }

            const results = this.timezoneFuse.search(query, { limit: 10 });
            const respondArr = new Array<ApplicationCommandOptionChoiceData>(results.length);
            for (let index = 0; index < results.length; index++) {
                const result = results[index];
                const value = result.item.name;
                const name = result.item.name;
                respondArr[index] = { name: name, value: value };
            }
            await interaction.respond(respondArr);
        } catch (error) {
            this.logger.info(`Got error with query ${query}:\n${error}`);
        }
    }

    private async sendNewLivesMessage(newVlivesInRegion: RegionToNewVliveCount): Promise<void> {
        if (SekaiVirtualLiveBot.instance.config === null) {
            throw new Error("SekaiVirtualLiveBot.instance.config is null");
        } else if (SekaiVirtualLiveBot.instance.client === null) {
            throw new Error("SekaiVirtualLiveBot.instance.client is null");
        }

        if (SekaiVirtualLiveBot.instance.config.newLivesChannels === null || SekaiVirtualLiveBot.instance.config.newLivesChannels.length === 0) {
            return;
        }

        SekaiVirtualLiveBot.instance.logger.info("sendNewLivesMessage()");

        let msg = "";
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

            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            if (SekaiVirtualLiveBot.instance.config.sekaiServers[region].newMessageContent != null && SekaiVirtualLiveBot.instance.config.sekaiServers[region].newMessageContent!.length > 0) {
                msg += `${SekaiVirtualLiveBot.instance.config.sekaiServers[region].newMessageContent}\n`;
            }
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

        if (SekaiVirtualLiveBot.instance.config.newLivesChannels !== null && SekaiVirtualLiveBot.instance.config.newLivesChannels.length > 0) {
            for (const channelId of SekaiVirtualLiveBot.instance.config.newLivesChannels) {
                SekaiVirtualLiveBot.instance.logger.info(`Sending new Virtual Lives message to channel ${channelId}`);
                try {
                    const channel = SekaiVirtualLiveBot.instance.client.channels.cache.get(channelId) as TextChannel;
                    const newMsgOptions: MessageCreateOptions = {
                        embeds: [embed],
                        components: btnRows
                    };
                    if (msg.length > 0) {
                        newMsgOptions.content = msg;
                    }

                    await channel.send(newMsgOptions);
                } catch (error) {
                    SekaiVirtualLiveBot.instance.logger.error(`Error sending new Virtual Lives message to channel ${channelId}, skipping: ${error}`);
                    continue;
                }
            }
        }
    }

    private async refreshVirtualLiveJob(job: Job): Promise<void> {
        try {
            await SekaiVirtualLiveBot.instance.refreshVirtualLive(null);
        } catch (error) {
            SekaiVirtualLiveBot.instance.logger.error(`Error during refreshVirtualLiveJob(): ${error}`);
            if (error instanceof Error || typeof(error) === "string") {
                job.fail(error);
            } else {
                job.fail(`Unknown error type: ${error}`);
            }
        }
    }

    private async refreshVirtualLive(region: string | null = null): Promise<void> {
        if (SekaiVirtualLiveBot.instance.cache === null) {
            throw new Error("SekaiVirtualLiveBot.instance.cache is null");
        }

        const newObj = await SekaiVirtualLiveBot.instance.cache.refreshCache(region);
        if (newObj.newFound) {
            await SekaiVirtualLiveBot.instance.sendNewLivesMessage(newObj);
        }
    }

    protected async handleReminderJob(job: Job): Promise<void> {
        try {
            if (job.attrs.data === undefined || job.attrs.lastRunAt === undefined) {
                throw new Error(`Bad job data: ${job.toJSON()}`);
            }

            if (SekaiVirtualLiveBot.instance.client === null) {
                throw new Error("SekaiVirtualLiveBot.instance.client is null");
            }

            const data = job.attrs.data as ReminderJobData<VirtualLiveReminderData>;
            const embed = await SekaiVirtualLiveBot.instance.buildReminderEmbed(
                SekaiVirtualLiveBot.instance.REMINDER_TRIGGERED_TITLE, data, 0xFFFFFF);
            const channel = await SekaiVirtualLiveBot.instance.client.channels.fetch(data.channelId);
            if (channel === null || !channel.isTextBased()) {
                const error = `Channel ID is unexpected: ${data.channelId}`;
                throw new Error(error);
            }

            const user = await SekaiVirtualLiveBot.instance.client.users.fetch(data.userId);
            await channel.send({
                content: user.toString(),
                embeds: [embed]
            });

            await job.remove();
        } catch (error) {
            const errStr = `Failed to finish reminder job: ${error}`;
            SekaiVirtualLiveBot.instance.logger.error(errStr);
            job.fail(errStr);
        }
    }

    protected async buildReminderEmbed(title: string, data: ReminderJobData<VirtualLiveReminderData>, color: ColorResolvable): Promise<EmbedBuilder> {
        if (this.client === null) {
            throw new Error("discord.js client not initialized");
        }

        const channel = await this.client.channels.fetch(data.channelId);
        if (channel === null || !channel.isTextBased()) {
            const error = `Channel ID is unexpected: ${data.channelId}`;
            throw new Error(error);
        }

        const description = await this.reminderDataToDescription(data.data);

        const unixTime = Math.round(data.reminderTime.getTime() / 1000);
        const embed = new EmbedBuilder()
            .setTitle(title)
            .addFields(
                { name: "Description:", value: description, inline: false },
                { name: "Reminder Time:", value: `<t:${unixTime}:F>`, inline: false },
                { name: "Channel:", value: channel.toString(), inline: false }
            )
            .setColor(color);

        return embed;
    }

    private async reminderDataToDescription(data: VirtualLiveReminderData): Promise<string> {
        if (SekaiVirtualLiveBot.instance.cache === null) {
            throw new Error("this.cache is null");
        }

        let vlive = SekaiVirtualLiveBot.instance.cache.getVliveById(data.region, data.vliveId);
        if (vlive === null) {
            SekaiVirtualLiveBot.instance.logger.info(`reminderDataToDescription(): Failed to find vlive with id ${data.vliveId} in region ${data.region}, refreshing cache`);
            await SekaiVirtualLiveBot.instance.refreshVirtualLive(data.region);
            vlive = SekaiVirtualLiveBot.instance.cache.getVliveById(data.region, data.vliveId);
            if (vlive === null) {
                SekaiVirtualLiveBot.instance.logger.error(`reminderDataToDescription(): Failed to find vlive with id ${data.vliveId} in region ${data.region} after refreshing cache`);
                return "A reminder for Virtual Live show was triggered, but I could not find the Virtual Live show data.\n\n" +
                    `Region: ${data.region}`;
            }
        }

        let schedule = SekaiVirtualLiveBot.instance.cache.getScheduleById(data.region, data.vliveId, data.scheduleId);
        if (schedule === null) {
            SekaiVirtualLiveBot.instance.logger.info(`reminderDataToDescription(): Failed to find schedule with id ${data.scheduleId} in vlive ${data.vliveId} in region ${data.region}, refreshing cache`);
            await SekaiVirtualLiveBot.instance.refreshVirtualLive(data.region);
            schedule = SekaiVirtualLiveBot.instance.cache.getScheduleById(data.region, data.vliveId, data.scheduleId);
            if (schedule === null) {
                SekaiVirtualLiveBot.instance.logger.error(`reminderDataToDescription(): Failed to find schedule with id ${data.scheduleId} in vlive ${data.vliveId} in region ${data.region} after refreshing cache`);
                return "Reminder for Virtual Live show:\n" +
                    `${vlive.name}\n\n` +
                    "A reminder for Virtual Live show was triggered, but I could not find the schedule data.\n\n" +
                    `Region: ${data.region}`;
            }
        }

        return "Reminder for Virtual Live show:\n" +
            `${vlive.name}\n\n` +
            `Virtual Live starts at: ${SekaiVirtualLiveBot.createDiscordTimestamp(schedule.startAt, TimestampStyles.LongDateTime)}\n\n` +
            `Region: ${data.region}`;
    }

    private static removePastSchedules(currentDate: Date, sortedSchedules: VirtualLiveSchedule[]): VirtualLiveSchedule[] {
        const newArr: VirtualLiveSchedule[] = [];
        for (const schedule of sortedSchedules) {
            if (schedule.startAt < currentDate) {
                continue;
            }

            newArr.push(schedule);
        }

        return newArr;
    }

    private static removePastVlives(currentDate: Date, sortedVlives: VirtualLive[]): VirtualLive[] {
        const newArr: VirtualLive[] = [];
        for (const vlive of sortedVlives) {
            if (vlive.endAt < currentDate) {
                continue;
            }

            newArr.push(vlive);
        }

        return newArr;
    }

    private static formatRelativeDifference(date: Date): string {
        const str = dayjs(date).fromNow(true);
        return "In about " + str;
    }

    private static subtractMinutes(date: Date, minutes: number): Date {
        return dayjs(date).subtract(minutes, "minutes").toDate();
    }

    private static createDiscordTimestamp(date: Date, style: TimestampStylesString) {
        return `<t:${Math.floor(date.getTime() / 1000)}:${style}>`;
    }

    private static serializeSchedule(region: string, schedule: VirtualLiveSchedule): string {
        return `${region}_${schedule.virtualLiveId}_${schedule.id}`;
    }

    private static deserializeSchedule(input: string): ScheduleInfo {
        const arr = input.split("_");
        return {
            region: arr[0],
            vliveId: parseInt(arr[1]),
            scheduleId: parseInt(arr[2])
        };
    }

    private static serializeVliveButton(region: string, vliveId: number): string {
        return `${SekaiVirtualLiveBot.VLIVE_NEW_BTN_PREFIX}${region}__${vliveId}`;
    }

    private static deserializeVliveButton(input: string): VliveButtonInfo {
        const arr = input.split("__");
        return {
            region: arr[1],
            vliveId: parseInt(arr[2])
        };
    }

    getIntents(): GatewayIntentBits[] {
        return this.intents;
    }

    getSlashCommands(): (SlashCommandBuilder | ContextMenuCommandBuilder)[] {
        return this.commands;
    }
}

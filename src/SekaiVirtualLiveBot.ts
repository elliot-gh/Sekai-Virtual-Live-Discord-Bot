import {
    ActionRowBuilder,
    APIApplicationCommandOptionChoice,
    AutocompleteInteraction,
    ButtonBuilder,
    ButtonInteraction,
    ButtonStyle,
    ChannelType,
    ChatInputCommandInteraction,
    Client,
    ContextMenuCommandBuilder,
    EmbedBuilder,
    GatewayIntentBits,
    Guild,
    Interaction,
    SlashCommandBuilder,
    TimestampStyles
} from "discord.js";
import { BaseBotWithConfig } from "../../../interfaces/BaseBotWithConfig.js";
import { EventHandlerDict } from "../../../interfaces/IBot.js";
import { ShouldIgnoreEvent } from "../../../utils/DiscordUtils.js";
import { MongoGuildSettings } from "./database/MongoGuildSettings.js";
import { MongoGuildUserSettings } from "./database/MongoGuildUserSettings.js";
import { MongooseConnection } from "./database/MongooseConnection.js";
import { MongoUserVliveReminders } from "./database/MongoUserVliveReminders.js";
import { MongoVirtualLive } from "./database/MongoVirtualLive.js";
import { AgendaSetup } from "./jobs/AgendaSetup.js";
import { createDiscordTimestamp } from "./utils/DateUtils.js";
import { BIG_GUILD_MEMBERCOUNT, BTN_DISMISS_ID_PREFIX, BTN_SINGLE_OPTIN_ID_PREFIX, buildErrorEmbed, deserializeDismissButtonId, deserializeSingleOptInButtonId } from "./utils/DiscordUtils.js";
import { VirtualLiveCache } from "./VirtualLiveCache.js";
import { SekaiVirtualLiveConfig } from "./VirtualLiveConfig.js";
import { isOfTypeRegionString, RegionString, VirtualLive } from "./VirtualLiveShared.js";

enum ScheduleButtonDirection {
    Prev,
    Next
}

type EmbedsAndActionRows = {
    embeds: EmbedBuilder[],
    actionRows: ActionRowBuilder<ButtonBuilder>[] | undefined
}

export class SekaiVirtualLiveBot extends BaseBotWithConfig {
    private static readonly SUBCMD_CONFIG_NEW_SHOWS = "new-show";
    private static readonly SUBCMD_CONFIG_CHANNEL = "channel";
    private static readonly SUBCMD_SCHEDULE = "schedule";
    private static readonly SUBCMDGRP_REMINDERS = "reminder";
    private static readonly SUBCMD_REMINDERS_AUTO = "auto";
    private static readonly SUBCMD_REMINDERS_SINGLE = "single";
    private static readonly SUBCMD_REMINDERS_DISMISS = "dismiss";
    private static readonly BTN_SCHEDULE_PREV = "vliveBot_btnSchedulePrev";
    private static readonly BTN_SCHEDULE_NEXT = "vliveBot_btnScheduleNext";
    private static readonly NORMAL_EMBED_COLOR = 0x33AAEE;
    private static readonly SUCCESS_EMBED_COLOR = 0x00FF00;
    private static readonly WARN_EMBED_COLOR = 0xFFCC00;
    private static readonly ERROR_EMBED_COLOR = 0xFF0000;

    private readonly intents: GatewayIntentBits[];
    private readonly commands: (SlashCommandBuilder | ContextMenuCommandBuilder)[];
    private readonly slashVlive: SlashCommandBuilder;
    private readonly slashConfig: SlashCommandBuilder;
    private readonly config: SekaiVirtualLiveConfig;
    private agendaSetup: AgendaSetup | null;

    constructor() {
        super("SekaiVirtualLiveBot", import.meta);

        this.config = this.readYamlConfig<SekaiVirtualLiveConfig>("config.yaml");
        this.intents = [GatewayIntentBits.Guilds];

        const choices: APIApplicationCommandOptionChoice<string>[] = [];
        for (const region in this.config.vliveDataSources) {
            if (!isOfTypeRegionString(region)) {
                this.logger.error(`Invalid region string: ${region}`);
                throw new Error(`Invalid region string ${region} in config`);
            }

            choices.push({ name: region, value: region });
        }

        this.slashConfig = new SlashCommandBuilder()
            .setName("config-vlive")
            .setDescription("Server configuration for Virtual Live bot.")
            .setDMPermission(false)
            .setDefaultMemberPermissions(0)
            .addSubcommand(subcommand =>
                subcommand
                    .setName(SekaiVirtualLiveBot.SUBCMD_CONFIG_NEW_SHOWS)
                    .setDescription("Set a message to be sent if new Virtual Lives are found. This is not the same as a reminder.")
                    .addStringOption(option =>
                        option
                            .setName("region")
                            .setDescription("Project Sekai region")
                            .setRequired(true)
                            .addChoices(choices)
                    )
                    .addBooleanOption(option =>
                        option
                            .setName("enable")
                            .setDescription("Note the message goes into the same channel as the reminders channel for the region.")
                            .setRequired(true)
                    )
            )
            .addSubcommand(subcommand =>
                subcommand
                    .setName(SekaiVirtualLiveBot.SUBCMD_CONFIG_CHANNEL)
                    .setDescription("Configure the channel where reminders are sent.")
                    .addStringOption(option =>
                        option
                            .setName("region")
                            .setDescription("Project Sekai region")
                            .setRequired(true)
                            .addChoices(choices)
                    )
                    .addChannelOption(option =>
                        option
                            .setName("channel")
                            .setDescription("Select a channel to enable, or leave empty to disable.")
                            .addChannelTypes(ChannelType.GuildText)
                            .setRequired(false)
                    )
            ) as SlashCommandBuilder;

        this.slashVlive = new SlashCommandBuilder()
            .setName("vlive")
            .setDescription("Configure reminders and view schedule.")
            .setDMPermission(false)
            .addSubcommand(subcommand =>
                subcommand
                    .setName(SekaiVirtualLiveBot.SUBCMD_SCHEDULE)
                    .setDescription("View current Virtual Lives schedules.")
                    .addStringOption(option =>
                        option
                            .setName("region")
                            .setDescription("Project Sekai region")
                            .setRequired(true)
                            .addChoices(choices)
                    )
                    .addBooleanOption(option =>
                        option
                            .setName("ephemeral")
                            .setDescription("True to show message only to you, false to show to server. Default is false.")
                            .setRequired(false)
                    )
            )
            .addSubcommandGroup(subcommandGroup =>
                subcommandGroup
                    .setName(SekaiVirtualLiveBot.SUBCMDGRP_REMINDERS)
                    .setDescription("Configure reminders for Virtual Lives.")
                    .addSubcommand(subcommand =>
                        subcommand
                            .setName(SekaiVirtualLiveBot.SUBCMD_REMINDERS_AUTO)
                            .setDescription("Configure auto reminders all Virtual Lives.")
                            .addStringOption(option =>
                                option
                                    .setName("region")
                                    .setDescription("Project Sekai region")
                                    .setRequired(true)
                                    .addChoices(choices)
                            )
                            .addBooleanOption(option =>
                                option
                                    .setName("enable")
                                    .setDescription("True to enable auto reminders on all shows, false to disable.")
                                    .setRequired(true)
                            )
                    )
                    .addSubcommand(subcommand =>
                        subcommand
                            .setName(SekaiVirtualLiveBot.SUBCMD_REMINDERS_SINGLE)
                            .setDescription("Configure a single reminder for a single Virtual Live.")
                            .addStringOption(option =>
                                option
                                    .setName("region")
                                    .setDescription("Project Sekai region")
                                    .setRequired(true)
                                    .addChoices(choices)
                            )
                            .addStringOption(option =>
                                option
                                    .setName("show")
                                    .setDescription("The Virtual Live show name. Autocompletes.")
                                    .setRequired(true)
                                    .setAutocomplete(true)
                            )
                    )
                    .addSubcommand(subcommand =>
                        subcommand
                            .setName(SekaiVirtualLiveBot.SUBCMD_REMINDERS_DISMISS)
                            .setDescription("Dismiss a reminder for a Virtual Live. You will no longer get reminded for this show.")
                            .addStringOption(option =>
                                option
                                    .setName("region")
                                    .setDescription("Project Sekai region")
                                    .setRequired(true)
                                    .addChoices(choices)
                            )
                            .addStringOption(option =>
                                option
                                    .setName("show")
                                    .setDescription("The Virtual Live show name. Autocompletes.")
                                    .setRequired(true)
                                    .setAutocomplete(true)
                            )
                    )
            ) as SlashCommandBuilder;

        this.commands = [this.slashConfig, this.slashVlive];
        this.agendaSetup = null;
    }

    async preInit(): Promise<string | null> {
        try {
            const connection = await MongooseConnection.getConnection(this.config);
            await MongoVirtualLive.init(this.config, connection);
            await VirtualLiveCache.init(this.config);
            await MongoGuildSettings.init(connection);
            await MongoGuildUserSettings.init(connection);
            await MongoUserVliveReminders.init(connection);
            return null;
        } catch (error) {
            const errMsg = `Error in init(): ${error}`;
            this.logger.error(errMsg);
            return errMsg;
        }
    }

    async useClient(client: Client<boolean>): Promise<void> {
        await AgendaSetup.init(this.config, client);
    }

    getEventHandlers(): EventHandlerDict {
        return {
            interactionCreate: this.processInteraction.bind(this),
            guildCreate: this.processGuildJoin.bind(this),
            guildDelete: this.processGuildLeave.bind(this)
        };
    }

    async processInteraction(interaction: Interaction): Promise<void> {
        if (ShouldIgnoreEvent(interaction)) {
            return;
        }

        if (interaction.isAutocomplete()) {
            if (interaction.commandName === this.slashVlive.name) {
                const subcmd = interaction.options.getSubcommand();
                const subcmdGrp = interaction.options.getSubcommandGroup();
                if (subcmdGrp === SekaiVirtualLiveBot.SUBCMDGRP_REMINDERS) {
                    if (subcmd === SekaiVirtualLiveBot.SUBCMD_REMINDERS_DISMISS
                        || subcmd === SekaiVirtualLiveBot.SUBCMD_REMINDERS_SINGLE) {
                        await this.handleAutoCompleteShow(interaction);
                        return;
                    }
                }
            }
        } else if (interaction.isButton()) {
            if (interaction.customId.startsWith(BTN_DISMISS_ID_PREFIX)) {
                await this.handleDismissButton(interaction);
                return;
            } else if (interaction.customId.startsWith(BTN_SINGLE_OPTIN_ID_PREFIX)) {
                await this.handleOptInButton(interaction);
                return;
            } else if (interaction.customId === SekaiVirtualLiveBot.BTN_SCHEDULE_PREV) {
                await this.handleShowScheduleButton(interaction, ScheduleButtonDirection.Prev);
                return;
            } else if (interaction.customId === SekaiVirtualLiveBot.BTN_SCHEDULE_NEXT) {
                await this.handleShowScheduleButton(interaction, ScheduleButtonDirection.Next);
                return;
            }
        } else if (interaction.isChatInputCommand()) {
            if (interaction.commandName === this.slashConfig.name) {
                const subcmd = interaction.options.getSubcommand();
                if (subcmd === SekaiVirtualLiveBot.SUBCMD_CONFIG_NEW_SHOWS) {
                    await this.handleGuildConfigNewShows(interaction);
                    return;
                } else if (subcmd === SekaiVirtualLiveBot.SUBCMD_CONFIG_CHANNEL) {
                    await this.handleGuildConfigChannel(interaction);
                    return;
                }
            } else if (interaction.commandName === this.slashVlive.name) {
                const subcmd = interaction.options.getSubcommand();
                const subcmdGrp = interaction.options.getSubcommandGroup();
                if (subcmdGrp === SekaiVirtualLiveBot.SUBCMDGRP_REMINDERS) {
                    if (subcmd === SekaiVirtualLiveBot.SUBCMD_REMINDERS_AUTO) {
                        await this.configureAutoRemindersCommand(interaction);
                        return;
                    } else if (subcmd === SekaiVirtualLiveBot.SUBCMD_REMINDERS_SINGLE) {
                        await this.handleSingleReminderCommand(interaction);
                        return;
                    } else if (subcmd === SekaiVirtualLiveBot.SUBCMD_REMINDERS_DISMISS) {
                        await this.handleDismissReminderCommand(interaction);
                    }
                } else if (subcmdGrp === null) {
                    if (subcmd === SekaiVirtualLiveBot.SUBCMD_SCHEDULE) {
                        await this.handleShowScheduleCommand(interaction);
                        return;
                    }
                }
            }
        }
    }

    private async handleDismiss(guild: Guild, userId: string, region: RegionString, vliveId: string): Promise<EmbedBuilder> {
        const vlive = VirtualLiveCache.getVliveById(region, vliveId);
        const reminders = await MongoUserVliveReminders.getUserVliveReminders(guild.id, region, vliveId);
        if (reminders === null) {
            const newReminder = await MongoUserVliveReminders.createEmptyUserVliveReminders(guild.id, region, vliveId);
            newReminder.users.push({ userId: userId, dismissed: true });
            await newReminder.save();
        } else {
            const user = reminders.users.find(user => user.userId === userId);
            if (user === undefined) {
                reminders.users.push({ userId: userId, dismissed: true });
                await reminders.save();
            } else {
                user.dismissed = true;
                await reminders.save();
            }
        }

        return new EmbedBuilder()
            .setTitle("Success")
            .setDescription(`You will no longer get reminders for ${vlive?.name}.`)
            .setColor(SekaiVirtualLiveBot.SUCCESS_EMBED_COLOR);
    }

    private async handleOptIn(guild: Guild, userId: string, region: RegionString, vliveId: string): Promise<EmbedBuilder> {
        const vlive = VirtualLiveCache.getVliveById(region, vliveId);
        const reminders = await MongoUserVliveReminders.getUserVliveReminders(guild.id, region, vliveId);
        if (reminders === null) {
            const newReminder = await MongoUserVliveReminders.createEmptyUserVliveReminders(guild.id, region, vliveId);
            newReminder.users.push({ userId: userId, dismissed: false });
            await newReminder.save();
        } else {
            const user = reminders.users.find(user => user.userId === userId);
            if (user === undefined) {
                reminders.users.push({ userId: userId, dismissed: false });
                await reminders.save();
            } else {
                user.dismissed = false;
                await reminders.save();
            }
        }

        let guildSettings = await MongoGuildSettings.getGuildSettingsForId(guild.id);
        guildSettings = await MongoGuildSettings.validateAndFixGuildSettings(guild, guildSettings);

        if (guild.memberCount > BIG_GUILD_MEMBERCOUNT) {
            if (guildSettings?.regionSettings[region]?.channelId == undefined) {
                return new EmbedBuilder()
                    .setTitle("Error")
                    .setDescription("This server is too large for pinged reminders. This server can still get non-pinged reminders, but the moderators have not yet configured the bot.")
                    .setColor(SekaiVirtualLiveBot.ERROR_EMBED_COLOR);
            } else {
                return new EmbedBuilder()
                    .setTitle("Warning")
                    .setDescription(`This server is too large for pinged reminders. This server will still get non-pinged reminders in <#${guildSettings.regionSettings[region]!.channelId}>.`)
                    .setColor(SekaiVirtualLiveBot.WARN_EMBED_COLOR);
            }
        } else {
            if (guildSettings?.regionSettings[region]?.channelId == undefined) {
                return new EmbedBuilder()
                    .setTitle("Warning")
                    .setDescription(`You enabled reminders for ${vlive?.name}, but the moderators have not yet configured the bot.`)
                    .setColor(SekaiVirtualLiveBot.WARN_EMBED_COLOR);
            } else {
                return new EmbedBuilder()
                    .setTitle("Success")
                    .setDescription(`You will get pinged for reminders for ${vlive?.name} in <#${guildSettings.regionSettings[region]!.channelId}>.`)
                    .setColor(SekaiVirtualLiveBot.SUCCESS_EMBED_COLOR);
            }
        }
    }

    private async handleAutoCompleteShow(interaction: AutocompleteInteraction): Promise<void> {
        const region = interaction.options.getString("region", true);
        const show = interaction.options.getString("show", true);
        this.logger.info(`Got autocomplete request for region ${region} and show ${show}`);

        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            throw new Error(`Invalid region string: ${region}`);
        }

        const searchResults = VirtualLiveCache.searchVlivesByName(region, show);
        this.logger.info(`got ${searchResults.length} search results`);
        await interaction.respond(
            searchResults.map(vliveName => ({
                name: vliveName,
                value: VirtualLiveCache.deserializeVliveIdFromSearchString(vliveName)
            })));
    }

    private async handleDismissButton(interaction: ButtonInteraction): Promise<void> {
        this.logger.info(`Got dismiss button request by ${interaction.user.toString()} in guild ${interaction.guildId}`);
        await interaction.deferReply({ ephemeral: true });

        if (interaction.guild === null || interaction.guildId === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.member === null) {
            this.logger.error(`No member found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No member found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        const buttonData = deserializeDismissButtonId(interaction.customId);
        if (buttonData === null) {
            this.logger.error(`Invalid button ID: ${interaction.customId}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Invalid button ID. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        try {
            const embed = await this.handleDismiss(interaction.guild, interaction.user.id, buttonData.region, buttonData.vliveId);
            await interaction.editReply({ embeds: [embed], allowedMentions: { repliedUser: true } });
        } catch (error) {
            this.logger.error(`Error in handleDismissButton: ${error}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
        }
    }

    private async handleDismissReminderCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        this.logger.info(`Got dismiss command by ${interaction.user.toString()} in guild ${interaction.guildId}`);
        await interaction.deferReply({ ephemeral: true });

        const region = interaction.options.getString("region", true);
        const show = interaction.options.getString("show", true);
        this.logger.info(`region: ${region}, show: ${show}`);

        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.guild === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        try {
            const embed = await this.handleDismiss(interaction.guild, interaction.user.id, region, show);
            await interaction.editReply({ embeds: [embed], allowedMentions: { repliedUser: true } });
        } catch (error) {
            this.logger.error(`Error in handleDismissReminderCommand: ${error}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
        }
    }

    private async handleOptInButton(interaction: ButtonInteraction): Promise<void> {
        this.logger.info(`Got opt-in button request by ${interaction.user.toString()} in guild ${interaction.guildId}`);
        await interaction.deferReply({ ephemeral: true });

        if (interaction.guild === null || interaction.guildId === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.member === null) {
            this.logger.error(`No member found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No member found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        const buttonData = deserializeSingleOptInButtonId(interaction.customId);
        if (buttonData === null) {
            this.logger.error(`Invalid button ID: ${interaction.customId}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Invalid button ID. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        try {
            const embed = await this.handleOptIn(interaction.guild, interaction.user.id, buttonData.region, buttonData.vliveId);
            await interaction.editReply({ embeds: [embed], allowedMentions: { repliedUser: true } });
        } catch (error) {
            this.logger.error(`Error in handleOptInButton: ${error}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
        }
    }

    private async handleSingleReminderCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        this.logger.info(`Got single reminder command by ${interaction.user.toString()} in guild ${interaction.guildId}`);
        await interaction.deferReply({ ephemeral: true });

        const region = interaction.options.getString("region", true);
        const show = interaction.options.getString("show", true);

        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        if (!VirtualLiveCache.getVliveById(region, show)) {
            this.logger.error(`Invalid show name: ${show}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                `You passed in an invalid option: \`${show}\`. Please only select from the autocomplete options provided.`);
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.guild === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed],  allowedMentions: { repliedUser: true } });
            return;
        }

        try {
            const embed = await this.handleOptIn(interaction.guild, interaction.user.id, region, show);
            await interaction.editReply({ embeds: [embed], allowedMentions: { repliedUser: true } });
        } catch (error) {
            this.logger.error(`Error in handleSingleReminderCommand: ${error}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
        }
    }

    private async configureAutoRemindersCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        this.logger.info(`Got auto reminders command by ${interaction.user.toString()} in guild ${interaction.guildId}`);
        await interaction.deferReply({ ephemeral: true });

        const region = interaction.options.getString("region", true);
        const enabled = interaction.options.getBoolean("enable", true);
        this.logger.info(`region: ${region}, enable: ${enabled}`);

        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.guild === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        try {
            let userSettings = await MongoGuildUserSettings.getUserSettingsForId(interaction.guild.id, interaction.user.id);
            userSettings = await MongoGuildUserSettings.validateAndFixGuildUserSettings(interaction.guild.id, interaction.user.id, userSettings);
            if (userSettings.autoReminders[region] === undefined) {
                userSettings.autoReminders[region] = { enabled: enabled };
            } else {
                userSettings.autoReminders[region]!.enabled = enabled;
            }

            await userSettings.save();

            const guildSettings = await MongoGuildSettings.getGuildSettingsForId(interaction.guild.id);
            let embed: EmbedBuilder;
            if (!enabled) {
                embed = new EmbedBuilder()
                    .setTitle("Success")
                    .setDescription(`You will no longer get automatically pinged for all shows for the ${region} region.`)
                    .setColor(SekaiVirtualLiveBot.SUCCESS_EMBED_COLOR);
            } else if (interaction.guild.memberCount > BIG_GUILD_MEMBERCOUNT) {
                if (guildSettings?.regionSettings[region]?.channelId == undefined) {
                    embed = new EmbedBuilder()
                        .setTitle("Error")
                        .setDescription("This server is too large for pinged reminders. This server can still get non-pinged reminders, but the moderators have not yet configured the bot.")
                        .setColor(SekaiVirtualLiveBot.ERROR_EMBED_COLOR);
                } else {
                    embed = new EmbedBuilder()
                        .setTitle("Warning")
                        .setDescription(`This server is too large for pinged reminders. This server will still get non-pinged reminders in <#${guildSettings.regionSettings[region]!.channelId}> for the ${region} region.`)
                        .setColor(SekaiVirtualLiveBot.WARN_EMBED_COLOR);
                }
            } else {
                if (guildSettings?.regionSettings[region]?.channelId == undefined) {
                    embed = new EmbedBuilder()
                        .setTitle("Warning")
                        .setDescription(`You enabled automatic reminders for all shows for the ${region} region, but the moderators have not yet configured the bot.`)
                        .setColor(SekaiVirtualLiveBot.WARN_EMBED_COLOR);
                } else {
                    embed = new EmbedBuilder()
                        .setTitle("Success")
                        .setDescription(`You will get automatically pinged for all shows in <#${guildSettings.regionSettings[region]!.channelId}> for the ${region} region.`)
                        .setColor(SekaiVirtualLiveBot.SUCCESS_EMBED_COLOR);
                }
            }

            await interaction.editReply({ embeds: [embed], allowedMentions: { repliedUser: true } });
        } catch (error) {
            this.logger.error(`Error in configureAutoRemindersCommand: ${error}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
        }
    }

    private async handleGuildConfigNewShows(interaction: ChatInputCommandInteraction): Promise<void> {
        this.logger.info(`Got config new shows request by ${interaction.user.toString()} in guild ${interaction.guildId}`);
        await interaction.deferReply({ ephemeral: true });

        const region = interaction.options.getString("region", true);
        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.guild === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        const enabled = interaction.options.getBoolean("enable", true);
        this.logger.info(`region: ${region}, enable: ${enabled} for guild ${interaction.guildId}`);

        let settings = await MongoGuildSettings.getGuildSettingsForId(interaction.guild.id);
        settings = await MongoGuildSettings.validateAndFixGuildSettings(interaction.guild, settings);

        let channelId: string | undefined = undefined;
        if (settings.regionSettings[region] === undefined) {
            this.logger.info(`Adding new region ${region} to settings for guild ${interaction.guild.id}`);
            settings.regionSettings[region] = {
                channelId: undefined,
                newShowsMessage: enabled
            };
        } else {
            channelId = settings.regionSettings[region]!.channelId;
            settings.regionSettings[region]!.newShowsMessage = enabled;
        }

        await settings.save();
        this.logger.info(`Saved settings for guild ${interaction.guild.id}. Existing channel ID is ${channelId}`);

        let description = `New shows message for the ${region} region has been ${enabled ? "enabled" : "disabled"}.\n\n`;
        if (enabled && channelId === undefined) {
            description += `The channel ID has not yet been configured. Please run \`${this.slashConfig.name} ${SekaiVirtualLiveBot.SUBCMD_CONFIG_CHANNEL}\` to configure the channel for both new show messages and reminders.`;
        } else if (enabled) {
            description += `The message will go to <#${channelId}>.`;
        }

        const embed = new EmbedBuilder()
            .setTitle("Success")
            .setDescription(description)
            .setColor(SekaiVirtualLiveBot.SUCCESS_EMBED_COLOR);

        await interaction.editReply({ embeds: [embed] });
    }

    private async handleGuildConfigChannel(interaction: ChatInputCommandInteraction): Promise<void> {
        this.logger.info(`Got config channels request by ${interaction.user.toString()} in guild ${interaction.guildId}`);
        await interaction.deferReply({ ephemeral: true });

        const region = interaction.options.getString("region", true);
        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.guild === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        const channel = interaction.options.getChannel("channel", false);
        if (channel !== null && channel.type !== ChannelType.GuildText) {
            this.logger.error(`Invalid channel type: ${channel.type}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Invalid channel type. Please select a text channel.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        this.logger.info(`region: ${region}, channel: ${channel?.id} for guild ${interaction.guildId}`);

        let settings = await MongoGuildSettings.getGuildSettingsForId(interaction.guild.id);
        settings = await MongoGuildSettings.validateAndFixGuildSettings(interaction.guild, settings);

        if (settings.regionSettings[region] === undefined) {
            this.logger.info(`Adding new region ${region} to settings for guild ${interaction.guild.id}`);
            settings.regionSettings[region] = {
                channelId: channel?.id ?? undefined,
                newShowsMessage: false
            };
        } else {
            settings.regionSettings[region]!.channelId = channel?.id ?? undefined;
        }

        await settings.save();
        this.logger.info(`Saved settings for guild ${interaction.guild.id}. New channel ID is ${channel?.id}`);

        let description = `Reminders channel for the ${region} region has been updated.\n\n`;
        if (channel !== null) {
            description += `The channel is now <#${channel.id}>.`;
        } else {
            description += "Reminders and new show messages have been **disabled**.";
        }

        const embed = new EmbedBuilder()
            .setTitle("Success")
            .setDescription(description)
            .setColor(SekaiVirtualLiveBot.SUCCESS_EMBED_COLOR);

        await interaction.editReply({ embeds: [embed] });
    }

    private async handleShowScheduleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
        const region = interaction.options.getString("region", true);
        const ephemeral = interaction.options.getBoolean("ephemeral", false) ?? false; // default to false
        await interaction.deferReply({ ephemeral: ephemeral });

        this.logger.info(`Got vlive schedule request for region ${region} in channel ${interaction.channel}`);
        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        const vlives = VirtualLiveCache.getAllVlives(region);
        if (vlives === null || vlives.length === 0) {
            this.logger.warn(`No Virtual Lives found for region ${region}`);
            const errorEmbed = buildErrorEmbed(
                "No Virtual Lives found",
                `No Virtual Lives found for the ${region} region.`,
                SekaiVirtualLiveBot.WARN_EMBED_COLOR);
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        const scheduleObj = this.buildVliveSchedule(vlives, 0);
        await interaction.editReply({
            embeds: scheduleObj.embeds,
            allowedMentions: { repliedUser: true },
            components: scheduleObj.actionRows });
    }

    private async handleShowScheduleButton(interaction: ButtonInteraction, direction: ScheduleButtonDirection) {
        if (interaction.user.id !== interaction.message.interaction?.user.id) {
            const errorEmbed = buildErrorEmbed(
                "Error",
                "You can only use these buttons on your own messages.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.message.embeds.length === 0) {
            this.logger.error(`No embed found in message: ${interaction.message.url}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No embeds found. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        this.logger.info(`Got schedule button request by ${interaction.user.toString()} in guild ${interaction.guildId} for direction ${direction}`);
        const embed = interaction.message.embeds[0];
        const footer = embed.footer;
        if (footer === null || footer.text === null) {
            this.logger.error(`No footer found in embed: ${interaction.message.url}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No footer found. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        const footerText = footer.text;
        const slashIndex = footerText.indexOf("/");
        const currentIndex = parseInt(footerText.substring(footerText.indexOf(" ") + 1, slashIndex)) - 1;
        if (isNaN(currentIndex)) {
            this.logger.error(`Invalid current index in footer: ${footerText}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Invalid number in footer. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        const fields = embed.fields;
        if (fields.length === 0) {
            this.logger.error(`No fields found in embed: ${interaction.message.url}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No fields found. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        const region = fields[0].value;
        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string in field: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Invalid region string in field. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        await interaction.deferUpdate();

        const vlives = VirtualLiveCache.getAllVlives(region);
        if (vlives === null || vlives.length === 0) {
            this.logger.warn(`No Virtual Lives found for region ${region}`);
            const errorEmbed = buildErrorEmbed(
                "No Virtual Lives found",
                `No Virtual Lives found for the ${region} region.`,
                SekaiVirtualLiveBot.WARN_EMBED_COLOR);
            await interaction.editReply({ embeds: [errorEmbed], allowedMentions: { repliedUser: true } });
            return;
        }

        let newIndex = currentIndex;
        if (direction === ScheduleButtonDirection.Prev) {
            newIndex--;
        } else {
            newIndex++;
        }

        const scheduleObj = this.buildVliveSchedule(vlives, newIndex);
        await interaction.editReply({
            embeds: scheduleObj.embeds,
            allowedMentions: { repliedUser: false },
            components: scheduleObj.actionRows
        });
    }

    private buildVliveSchedule(vlives: VirtualLive[], currentIndex: number): EmbedsAndActionRows {
        if (vlives.length === 0) {
            this.logger.error(`Empty virtual live array. Got current index ${currentIndex}`);
            return {
                embeds: [buildErrorEmbed("Error", "No Virtual Lives found.")],
                actionRows: undefined
            };
        } else if (currentIndex < 0) {
            currentIndex = vlives.length - 1;
        } else if (currentIndex >= vlives.length) {
            currentIndex = 0;
        }

        const currentDate = new Date();
        const vlive = vlives[currentIndex];
        let description = "Showtimes:";
        for (const schedule of vlive.virtualLiveSchedules) {
            if (schedule.endAt < currentDate) {
                continue;
            }

            const startAt = createDiscordTimestamp(schedule.startAt, TimestampStyles.ShortDateTime);
            const endAt = createDiscordTimestamp(schedule.endAt, TimestampStyles.ShortTime);
            description += `\n• ${startAt} - ${endAt}`;
        }

        const embed = new EmbedBuilder()
            .setTitle(vlive.name)
            .setDescription(description)
            .addFields({ name: "Region", value: vlive.region, inline: false })
            .setFooter({ text: `Show ${currentIndex + 1}/${vlives.length}` })
            .setColor(SekaiVirtualLiveBot.NORMAL_EMBED_COLOR);

        const prevButton = new ButtonBuilder()
            .setLabel("Previous")
            .setCustomId(SekaiVirtualLiveBot.BTN_SCHEDULE_PREV)
            .setStyle(ButtonStyle.Primary);

        const nextButton = new ButtonBuilder()
            .setLabel("Next")
            .setCustomId(SekaiVirtualLiveBot.BTN_SCHEDULE_NEXT)
            .setStyle(ButtonStyle.Primary);

        const actionRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(prevButton, nextButton);

        return {
            embeds: [embed],
            actionRows: [actionRow]
        };
    }

    private async processGuildJoin(guild: Guild): Promise<void> {
        this.logger.info(`Guild ${guild.id} joined`);
        await guild.fetch();
        this.logger.info(`Guild ${guild.name} (${guild.id}) has ${guild.memberCount} members.`);
        const settings = await MongoGuildSettings.getGuildSettingsForId(guild.id);
        if (settings !== null) {
            settings.isGuildActive = true;
            this.logger.info(`Guild ${guild.name} already has settings. Marking guild as active.`);
            await settings.save();
            return;
        }

        this.logger.info(`Creating new settings for guild ${guild.name}`);
        try {
            await MongoGuildSettings.createEmptyGuildSettingsDocument(guild);

            if (guild.systemChannel === null) {
                this.logger.warn(`No system channel found for guild ${guild.name}`);
                return;
            }

            let description = "For this bot to work properly, moderators will need to configure the bot. Look under `/config-vlive` command for various options.\n\n";
            if  (guild.memberCount >= BIG_GUILD_MEMBERCOUNT) {
                description += "This server has a large number of members. Pings for reminders are disabled. Moderators must still configure the bot to get non-ping reminders.";
            } else {
                description += "Regular users can look under `/vlive` command for reminders and show schedules. Reminders will not work until moderators setup the bot.";
            }

            const embed = new EmbedBuilder()
                .setTitle("Setup Required")
                .setDescription(description)
                .setColor(SekaiVirtualLiveBot.NORMAL_EMBED_COLOR);

            await guild.systemChannel.send({ embeds: [embed] });
        } catch (error) {
            this.logger.error(`Failure during processGuildJoin for ${guild.id}: ${error}`);
            const embed = buildErrorEmbed(
                "Error",
                "Error during server first time join. This is unexpected; please contact the bot owner.");
            await guild.systemChannel?.send({ embeds: [embed] });
        }
    }

    private async processGuildLeave(guild: Guild): Promise<void> {
        this.logger.info(`Guild ${guild.name} left. Marking guild as inactive.`);
        const settings = await MongoGuildSettings.getGuildSettingsForId(guild.id);
        if (settings === null) {
            this.logger.warn(`No settings found for guild ${guild.name}`);
            return;
        }

        settings.isGuildActive = false;
        await settings.save();
    }

    getIntents(): GatewayIntentBits[] {
        return this.intents;
    }

    getSlashCommands(): (SlashCommandBuilder | ContextMenuCommandBuilder)[] {
        return this.commands;
    }
}

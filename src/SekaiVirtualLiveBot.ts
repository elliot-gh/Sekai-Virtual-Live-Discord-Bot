import {
    APIApplicationCommandOptionChoice,
    AutocompleteInteraction,
    ButtonInteraction,
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
import { MongooseConnection } from "./database/MongooseConnection.js";
import { MongoVirtualLive } from "./database/MongoVirtualLive.js";
import { AgendaSetup } from "./jobs/AgendaSetup.js";
import { createDiscordTimestamp } from "./utils/DateUtils.js";
import { BTN_DISMISS_ID_PREFIX, BTN_SINGLE_OPTIN_ID_PREFIX, buildErrorEmbed, deserializeDismissButtonId } from "./utils/DiscordUtils.js";
import { VirtualLiveCache } from "./VirtualLiveCache.js";
import { isOfTypeRegionString, NO_CHANNEL_STR, RegionString, SekaiVirtualLiveConfig, VirtualLive } from "./VirtualLiveShared.js";

enum ScheduleButtonDirection {
    Prev,
    Next
}

export class SekaiVirtualLiveBot extends BaseBotWithConfig {
    private static readonly SUBCMD_CONFIG_NEW_SHOWS = "new-shows";
    private static readonly SUBCMD_CONFIG_REMINDERS = "reminders";
    private static readonly SUBCMD_SCHEDULE = "schedule";
    private static readonly SUBCMDGRP_REMINDERS = "reminders";
    private static readonly SUBCMD_REMINDERS_AUTO = "auto";
    private static readonly SUBCMD_REMINDERS_SINGLE = "single";
    private static readonly SUBCMD_REMINDERS_DISMISS = "dismiss";
    private static readonly BTN_SCHEDULE_PREV = "vliveBot_btnSchedulePrev";
    private static readonly BTN_SCHEDULE_NEXT = "vliveBot_btnScheduleNext";
    private static readonly NORMAL_EMBED_COLOR = 0x33AAEE;
    private static readonly SUCCESS_EMBED_COLOR = 0x00FF00;
    private static readonly WARN_EMBED_COLOR = 0xFFCC00;

    private readonly intents: GatewayIntentBits[];
    private readonly commands: (SlashCommandBuilder | ContextMenuCommandBuilder)[];
    private readonly slashVlive: SlashCommandBuilder;
    private readonly slashConfig: SlashCommandBuilder;
    private readonly config: SekaiVirtualLiveConfig;
    private agendaSetup: AgendaSetup | null;

    constructor() {
        super("SekaiVirtualLiveBot", import.meta);

        this.config = this.readYamlConfig<SekaiVirtualLiveConfig>("config.yaml");
        this.intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];

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
                    .setName(SekaiVirtualLiveBot.SUBCMD_CONFIG_REMINDERS)
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
            await VirtualLiveCache.syncCacheWithDatabase();
            await MongoGuildSettings.init(connection);
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
                if (subcmdGrp === SekaiVirtualLiveBot.SUBCMD_CONFIG_REMINDERS) {
                    if (subcmd === SekaiVirtualLiveBot.SUBCMD_REMINDERS_DISMISS
                        || subcmd === SekaiVirtualLiveBot.SUBCMD_REMINDERS_SINGLE) {
                        await this.handleAutoCompleteShow(interaction);
                        return;
                    }
                }
            }
        } else if (interaction.isButton()) {
            if (interaction.id.startsWith(BTN_DISMISS_ID_PREFIX)) {
                await this.handleDismissButton(interaction);
                return;
            } else if (interaction.id.startsWith(BTN_SINGLE_OPTIN_ID_PREFIX)) {
                await this.handleOptInButton(interaction);
                return;
            } else if (interaction.id === SekaiVirtualLiveBot.BTN_SCHEDULE_PREV) {
                await this.handleShowScheduleButton(interaction, ScheduleButtonDirection.Prev);
                return;
            } else if (interaction.id === SekaiVirtualLiveBot.BTN_SCHEDULE_NEXT) {
                await this.handleShowScheduleButton(interaction, ScheduleButtonDirection.Next);
                return;
            }
        } else if (interaction.isChatInputCommand()) {
            if (interaction.commandName === this.slashConfig.name) {
                const subcmd = interaction.options.getSubcommand();
                if (subcmd === SekaiVirtualLiveBot.SUBCMD_CONFIG_NEW_SHOWS) {
                    await this.handleGuildConfigNewShows(interaction);
                    return;
                } else if (subcmd === SekaiVirtualLiveBot.SUBCMD_CONFIG_REMINDERS) {
                    await this.handleGuildConfigReminders(interaction);
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
        const roleSettings = await MongoGuildSettings.getVliveRoleSettings(guild.id, region, vliveId);
        if (roleSettings === null) {
            this.logger.error(`Role settings not found for region ${region} and vlive ID ${vliveId}`);
            return buildErrorEmbed(
                "Error",
                "Role settings not found. This is unexpected; please contact the bot owner.");
        }

        const role = await guild.roles.fetch(roleSettings.roleId);
        if (role === null) {
            this.logger.error(`Role ${roleSettings.roleId} not found in guild ${guild.id}`);
            return buildErrorEmbed(
                "Error",
                "Role not found. This is unexpected; please contact the bot owner.");
        }

        try {
            await guild.members.removeRole({
                role: role.id,
                user: userId
            });
        } catch (error) {
            this.logger.error(`Error removing role: ${error}`);
            return buildErrorEmbed(
                "Error",
                "Error removing role. This is unexpected; please contact the bot owner.");
        }

        const vlive = VirtualLiveCache.getVliveById(region, vliveId);
        return new EmbedBuilder()
            .setTitle("Success")
            .setDescription(`You will no longer get reminders for ${vlive?.name}.`)
            .setColor(SekaiVirtualLiveBot.SUCCESS_EMBED_COLOR);
    }

    private async handleOptIn(guild: Guild, userId: string, region: RegionString, vliveId: string): Promise<EmbedBuilder> {
        const roleSettings = await MongoGuildSettings.getVliveRoleSettings(guild.id, region, vliveId);
        if (roleSettings === null) {
            this.logger.error(`Role settings not found for region ${region} and vlive ID ${vliveId}`);
            return buildErrorEmbed(
                "Error",
                "Role settings not found. This is unexpected; please contact the bot owner.");
        }

        const role = await guild.roles.fetch(roleSettings.roleId);
        if (role === null) {
            this.logger.error(`Role ${roleSettings.roleId} not found in guild ${guild.id}`);
            return buildErrorEmbed(
                "Error",
                "Role not found. This is unexpected; please contact the bot owner.");
        }

        try {
            await guild.members.addRole({
                role: role.id,
                user: userId,
            });
        } catch (error) {
            this.logger.error(`Error adding role: ${error}`);
            return buildErrorEmbed(
                "Error",
                "Error adding role. This is unexpected; please contact the bot owner.");
        }

        const vlive = VirtualLiveCache.getVliveById(region, vliveId);
        return new EmbedBuilder()
            .setTitle("Success")
            .setDescription(`You will now get reminders for ${vlive?.name}.`)
            .setColor(SekaiVirtualLiveBot.SUCCESS_EMBED_COLOR);
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

        if (interaction.guild === null || interaction.guildId === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.member === null) {
            this.logger.error(`No member found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No member found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        const buttonData = deserializeDismissButtonId(interaction.customId);
        if (buttonData === null) {
            this.logger.error(`Invalid button ID: ${interaction.customId}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Invalid button ID. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

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

        const region = interaction.options.getString("region", true);
        const show = interaction.options.getString("show", true);
        this.logger.info(`region: ${region}, show: ${show}`);

        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.guild === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
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

        if (interaction.guild === null || interaction.guildId === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.member === null) {
            this.logger.error(`No member found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No member found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        const buttonData = deserializeDismissButtonId(interaction.customId);
        if (buttonData === null) {
            this.logger.error(`Invalid button ID: ${interaction.customId}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Invalid button ID. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

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

        const region = interaction.options.getString("region", true);
        const show = interaction.options.getString("show", true);

        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        if (!VirtualLiveCache.getVliveFromSearchString(region, show)) {
            this.logger.error(`Invalid show name: ${show}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                `You passed in an invalid option: \`${show}\`. Please only select from the autocomplete options provided.`);
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.guild === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

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

        const region = interaction.options.getString("region", true);
        const enabled = interaction.options.getBoolean("enable", true);
        this.logger.info(`region: ${region}, enable: ${enabled}`);

        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.guild === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            await MongoGuildSettings.setAutoRemindersSettings(interaction.guild.id, interaction.user.id, region, enabled);
            const embed = new EmbedBuilder()
                .setTitle("Success")
                .setDescription(`Auto reminders for all Virtual Lives in region ${region} have been ${enabled ? "enabled" : "disabled"}.`)
                .setColor(SekaiVirtualLiveBot.SUCCESS_EMBED_COLOR);
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
        this.logger.info(`Got \`/config-vlive new-shows\` request by ${interaction.user.toString()} in guild ${interaction.guildId}`);

        const region = interaction.options.getString("region", true);
        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.guild === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        const enable = interaction.options.getBoolean("enable", true);
        await interaction.deferReply({ ephemeral: true });
        this.logger.info(`region: ${region}, enable: ${enable} for guild ${interaction.guildId}`);

        let settings = await MongoGuildSettings.getGuildSettings(interaction.guild.id);
        settings = await MongoGuildSettings.validateAndFixGuildSettings(this.logger, interaction.guild.id, settings);

        let channelId = NO_CHANNEL_STR;
        let found = false;
        for (const regionSetting of settings.guildSettings.regions) {
            if (regionSetting.region === region) {
                regionSetting.newShowsMessage = enable;
                channelId = regionSetting.channelId;
                this.logger.info(`Found existing region ${region} in settings for guild ${interaction.guild.id}`);
                found = true;
                break;
            }
        }

        if (!found) {
            this.logger.info(`Adding new region ${region} to settings for guild ${interaction.guild.id}`);
            settings.guildSettings.regions.push({
                region: region,
                channelId: NO_CHANNEL_STR,
                newShowsMessage: enable
            });
        }

        await settings.save();
        this.logger.info(`Saved settings for guild ${interaction.guild.id}. Existing channel ID is ${channelId}`);

        let description = `New shows message for region ${region} has been ${enable ? "enabled" : "disabled"}.\n\n`;
        if (channelId === NO_CHANNEL_STR && enable) {
            description += `The channel ID has not yet been configured. Please run \`${this.slashConfig.name} ${SekaiVirtualLiveBot.SUBCMD_CONFIG_REMINDERS}\` to configure the channel for both new show messages and reminders.`;
        } else if (enable) {
            description += `The message will go to <#${channelId}>.`;
        }

        const embed = new EmbedBuilder()
            .setTitle("Success")
            .setDescription(description)
            .setColor(SekaiVirtualLiveBot.SUCCESS_EMBED_COLOR);

        await interaction.editReply({ embeds: [embed] });
    }

    private async handleGuildConfigReminders(interaction: ChatInputCommandInteraction): Promise<void> {
        this.logger.info(`Got \`/config-vlive reminders\` request by ${interaction.user.toString()} in guild ${interaction.guildId}`);

        const region = interaction.options.getString("region", true);
        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        if (interaction.guild === null) {
            this.logger.error(`No guild found in interaction: ${interaction.id}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No guild found in interaction. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        const channel = interaction.options.getChannel("channel", false);
        if (channel !== null && channel.type !== ChannelType.GuildText) {
            this.logger.error(`Invalid channel type: ${channel.type}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Invalid channel type. Please select a text channel.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        await interaction.deferReply({ ephemeral: true });
        this.logger.info(`region: ${region}, channel: ${channel?.id} for guild ${interaction.guildId}`);

        let settings = await MongoGuildSettings.getGuildSettings(interaction.guild.id);
        settings = await MongoGuildSettings.validateAndFixGuildSettings(this.logger, interaction.guild.id, settings);

        let found = false;
        for (const regionSetting of settings.guildSettings.regions) {
            if (regionSetting.region === region) {
                regionSetting.channelId = channel?.id ?? NO_CHANNEL_STR;
                this.logger.info(`Found existing region ${region} in settings for guild ${interaction.guild.id}`);
                found = true;
                break;
            }
        }

        if (!found) {
            this.logger.info(`Adding new region ${region} to settings for guild ${interaction.guild.id}`);
            settings.guildSettings.regions.push({
                region: region,
                channelId: channel?.id ?? "",
                newShowsMessage: false
            });
        }

        await settings.save();
        this.logger.info(`Saved settings for guild ${interaction.guild.id}. New channel ID is ${channel?.id}`);

        let description = `Reminders channel for region ${region} has been updated.\n\n`;
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

        this.logger.info(`Got vlive schedule request for region ${region} in channel ${interaction.channel}`);
        if (!isOfTypeRegionString(region)) {
            this.logger.error(`Invalid region string: ${region}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "Unknown error occurred with region input. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

        const vlives = VirtualLiveCache.getAllVlives(region);
        if (vlives === null) {
            this.logger.warn(`No Virtual Lives found for region ${region}`);
            const errorEmbed = buildErrorEmbed(
                "No Virtual Lives found",
                `No Virtual Lives found for region ${region}.`,
                SekaiVirtualLiveBot.WARN_EMBED_COLOR);
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: false } });
            return;
        }

        const embed = this.buildVliveScheduleEmbed(vlives, 0);
        await interaction.reply({ embeds: [embed], ephemeral: ephemeral, allowedMentions: { repliedUser: false }});
    }

    private async handleShowScheduleButton(interaction: ButtonInteraction, direction: ScheduleButtonDirection) {
        if (interaction.message.embeds.length === 0) {
            this.logger.error(`No embed found in message: ${interaction.message.url}`);
            const errorEmbed = buildErrorEmbed(
                "Error",
                "No embeds found. This is unexpected; please contact the bot owner.");
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: true } });
            return;
        }

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
        const currentIndex = parseInt(footerText.substring(footerText.indexOf(" ") + 1, slashIndex));
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

        const vlives = VirtualLiveCache.getAllVlives(region);
        if (vlives === null) {
            this.logger.warn(`No Virtual Lives found for region ${region}`);
            const errorEmbed = buildErrorEmbed(
                "No Virtual Lives found",
                `No Virtual Lives found for region ${region}.`,
                SekaiVirtualLiveBot.WARN_EMBED_COLOR);
            await interaction.reply({ embeds: [errorEmbed], ephemeral: true, allowedMentions: { repliedUser: false } });
            return;
        }

        let newIndex = currentIndex;
        if (direction === ScheduleButtonDirection.Prev) {
            newIndex--;
        } else {
            newIndex++;
        }

        const newEmbed = this.buildVliveScheduleEmbed(vlives, newIndex);
        await interaction.update({ embeds: [newEmbed] });
    }

    private buildVliveScheduleEmbed(vlives: VirtualLive[], currentIndex: number): EmbedBuilder {
        if (vlives.length === 0) {
            this.logger.error(`Empty virtual live array. Got current index ${currentIndex}`);
            throw new Error("No Virtual Lives found. Contact bot owner.");
        } else if (currentIndex < 0) {
            currentIndex = vlives.length - 1;
        } else if (currentIndex >= vlives.length) {
            currentIndex = 0;
        }

        const vlive = vlives[currentIndex];
        let description = "Showtimes:";
        for (const schedule of vlive.virtualLiveSchedules) {
            const startAt = createDiscordTimestamp(schedule.startAt, TimestampStyles.ShortDateTime);
            const endAt = createDiscordTimestamp(schedule.endAt, TimestampStyles.ShortTime);
            description += `\n• ${startAt} - ${endAt}`;
        }

        return new EmbedBuilder()
            .setTitle(vlive.name)
            .setDescription(description)
            .addFields({ name: "Region", value: vlive.region, inline: false })
            .setFooter({ text: `Show ${currentIndex + 1}/${vlives.length}` })
            .setColor(SekaiVirtualLiveBot.NORMAL_EMBED_COLOR);
    }

    private async processGuildJoin(guild: Guild): Promise<void> {
        this.logger.info(`Guild ${guild.name} joined.`);
        const settings = await MongoGuildSettings.getGuildSettings(guild.id);
        if (settings !== null) {
            settings.isGuildActive = true;
            this.logger.info(`Guild ${guild.name} already has settings. Marking guild as active.`);
            await settings.save();
            return;
        }

        this.logger.info(`Creating new settings for guild ${guild.name}`);
        try {
            await MongoGuildSettings.createEmptyGuildSettingsDocument(guild.id);

            if (guild.systemChannel === null) {
                this.logger.info(`No system channel found for guild ${guild.name}`);
                return;
            }

            const embed = new EmbedBuilder()
                .setTitle("Setup Required")
                .setDescription(
                    "For this bot to work properly, moderators will need to configure the bot. Look under `/config-vlive` command for various options.\n\n" +
                    "Regular users can look under `/vlive` command for reminders and show schedules. Reminders will not work until moderators setup the bot.")
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
        const settings = await MongoGuildSettings.getGuildSettings(guild.id);
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

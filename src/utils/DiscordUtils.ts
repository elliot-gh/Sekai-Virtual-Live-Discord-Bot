import { ColorResolvable, EmbedBuilder } from "discord.js";
import { isOfTypeRegionString, RegionString } from "../VirtualLiveShared.js";

export function buildErrorEmbed(title: string, reason: string, color: ColorResolvable | null = null): EmbedBuilder {
    const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(reason)
        .setColor(color ?? 0xFF0000);
    return embed;
}

export function buildChannelErrorEmbed(channelId: string): EmbedBuilder {
    return buildErrorEmbed(
        "Channel error",
        `I tried to send a message but the channel <#${channelId}> (ID \`${channelId}\`) was not found or isn't a text channel.\n`
            + "Please reconfigure the bot or make sure the bot has access to the channel.",
        0xFF0000);
}

export const BTN_DISMISS_ID_PREFIX = "vliveBotBtnDismiss";
export function serializeDismissButtonId(region: RegionString, vliveId: number): string {
    return `${BTN_DISMISS_ID_PREFIX}_${region}_${vliveId}`;
}

export type DismissButtonData = {
    region: RegionString,
    vliveId: string
};

export function deserializeDismissButtonId(buttonId: string): DismissButtonData | null {
    const parts = buttonId.split("_");
    if (parts.length < 3 || parts[0] !== BTN_DISMISS_ID_PREFIX) {
        return null;
    } else if (!isOfTypeRegionString(parts[1])) {
        return null;
    }

    return {
        region: parts[1],
        vliveId: parts[2]
    };
}

export const BTN_SINGLE_OPTIN_ID_PREFIX = "vliveBotBtnSingleOptIn";
export function serializeSingleOptInButtonId(region: RegionString, vliveId: number): string {
    return `${BTN_SINGLE_OPTIN_ID_PREFIX}_${region}_${vliveId}`;
}

export type SingleOptInButtonData = {
    region: RegionString,
    vliveId: string
};

export function deserializeSingleOptInButtonId(buttonId: string): SingleOptInButtonData | null {
    const parts = buttonId.split("_");
    if (parts.length < 3 || parts[0] !== BTN_SINGLE_OPTIN_ID_PREFIX) {
        return null;
    } else if (!isOfTypeRegionString(parts[1])) {
        return null;
    }

    return {
        region: parts[1],
        vliveId: parts[2]
    };
}

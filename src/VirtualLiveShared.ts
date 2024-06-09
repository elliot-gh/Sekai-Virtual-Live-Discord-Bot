/**
 * Supported region strings.
 * MAKE SURE TO ALSO UPDATE SCHEMAS IF UPDATING THIS
 */
export type RegionString = "English" | "Japanese" | "Korean" | "Taiwanese";
export const RegionStringArray: ReadonlyArray<RegionString> = ["English", "Japanese", "Korean", "Taiwanese"];
const regionStringDict: { [region: string]: boolean } = {
    "English": true,
    "Japanese": true,
    "Korean": true,
    "Taiwanese": true
};

/**
 * Type guard for RegionStrings.
 * @param val A string.
 * @returns True if val is a RegionStrings.
 */
export function isOfTypeRegionString(val: string): val is RegionString {
    return regionStringDict[val] !== undefined;
}

/**
 * A Virtual Live show.
 */
export interface VirtualLive {
    id: string;
    virtualLiveType: string;
    name: string;
    startAt: Date;
    endAt: Date;
    virtualLiveSchedules: VirtualLiveSchedule[];
    region: RegionString;
}

/**
 * A Virtual Live Schedule (the actual individual show times).
 */
export interface VirtualLiveSchedule {
    id: string;
    virtualLiveId: string;
    seq: number;
    startAt: Date;
    endAt: Date;
    region: RegionString;
}

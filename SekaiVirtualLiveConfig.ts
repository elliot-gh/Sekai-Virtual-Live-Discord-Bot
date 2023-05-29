export type SekaiVirtualLiveConfig = {
    refreshIntervalHours: number,
    defaultTimezone: string | null,
    newLivesChannels: string[] | null,
    sekaiServers: {
        [region: string]: {
            vliveDataUrl: string,
            newMessageContent: string | null
        }
    },
    mongoDb: {
        url: string,
        user: string,
        password: string,
        agendaCollection: string,
        virtualLiveCollection_prefix: string,
        userTimezoneCollection: string
    }
}

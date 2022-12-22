export type SekaiVirtualLiveConfig = {
    refreshIntervalHours: number,
    newLivesChannel: string | null,
    newMessageContent: string | null,
    sekaiServers: {
        [region: string]: string
    },
    mongoDb: {
        url: string,
        user: string,
        password: string,
        agendaCollection: string,
        virtualLiveCollection_prefix: string
    }
}

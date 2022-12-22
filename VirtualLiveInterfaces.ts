export interface VirtualLive {
    id: number,
    virtualLiveType: string,
    name: string,
    startAt: Date,
    endAt: Date,
    virtualLiveSchedules: VirtualLiveSchedule[]
}

export interface VirtualLiveSchedule {
    id: number,
    virtualLiveId: number,
    seq: number,
    startAt: Date,
    endAt: Date
}

import mongoose, { Connection } from "mongoose";
import { createLogger } from "../../../../utils/Logger.js";
import { SekaiVirtualLiveConfig } from "../VirtualLiveShared.js";

/**
 * Singleton responsible for creating a connection to MongoDB to be used by this bot.
 */
export class MongooseConnection {
    private static readonly logger = createLogger("MongooseConnection");
    private static connection: Connection;

    /**
     * Creates a singleton connection to MongoDB.
     * @param config config.yaml
     * @returns A promise that resolves to a connection to MongoDB.
     */
    static async getConnection(config: SekaiVirtualLiveConfig): Promise<Connection> {
        if (this.connection !== undefined) {
            return this.connection;
        }

        try {
            this.logger.info("Trying to connect to MongoDB URL...");
            const connection = await mongoose.createConnection(config.mongoDbUrl).asPromise();
            await connection.db.admin().ping();
            this.logger.info("Successfully connected to MongoDB.");
            this.connection = connection;
        } catch (error) {
            this.logger.error(`Ran into error in getConnection(): ${error}`);
            if (this.connection !== undefined) {
                await this.connection.close();
            }

            throw error;
        }

        return this.connection;
    }
}

import { Connection } from "typeorm";
import { QueueEntryEntity } from "../entities/queueEntry";
import { StudentStatus } from "../utilities/Global";

interface queueEntryOptions {
  question?: string;
  privateEntry?: boolean;
}

export default async (
  conn: Connection,
  userId: string,
  queueId: any,
  options?: queueEntryOptions
) => {
  try {
    const inputValues = {
      resolved: StudentStatus.Waiting,
      queue: queueId,
      userId: userId,
      ...options,
    };
    const result = await conn
      .createQueryBuilder()
      .insert()
      .into(QueueEntryEntity)
      .values(inputValues)
      .execute();
    return { ...inputValues, ...result.raw[0] };
  } catch (e) {
    console.log("Failed to add Queue Entry to Database", e);
    throw e;
  }
};

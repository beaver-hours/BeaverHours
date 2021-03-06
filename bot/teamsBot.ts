import { default as axios } from "axios";
import {
  CardFactory,
  TeamsActivityHandler,
  TurnContext,
  MessageFactory,
  ConversationParameters,
  TeamsInfo,
  Mention,
} from "botbuilder";
import * as querystring from "querystring";
import { Connection } from "typeorm";
import addQueueEntryToDb from "./api/addQueueEntryToDb";
import addQueueToDb from "./api/addQueueToDb";
import fetchQueuesByOwner from "./api/fetchQueuesByOwner";
import fetchQueueEntriesByQueueId from "./api/fetchQueueEntriesByQueueId";
import updateQueueStatusInDb from "./api/updateQueueStatusInDb";
import { QueueStatus } from "./utilities/Global";
import updateQueueEntryResolved from "./api/updateQueueEntryResolved";
import Queue from "./utilities/Queue";
import { getNamesOfTeamMembers } from "./api/getNamesOfTeamMembers";
import QueueEntry from "./utilities/QueueEntry";
import { StudentStatus } from "./utilities/Global";

export interface DataInterface {
  likeCount: number;
}

export class TeamsBot extends TeamsActivityHandler {
  // record the likeCount
  likeCountObj: { likeCount: number };
  activeQueue: Queue;
  dbConnection: Connection;

  constructor(dbConnection: Connection) {
    super();
    this.dbConnection = dbConnection;
    this.likeCountObj = { likeCount: 0 };
    this.activeQueue = null;

    this.onMessage(async (context, next) => {
      console.log("Running with Message Activity.");

      let txt = context.activity.text;
      const removedMentionText = TurnContext.removeRecipientMention(
        context.activity
      );
      if (removedMentionText) {
        // Remove the line break
        txt = removedMentionText.toLowerCase().replace(/\n|\r/g, "").trim();
      }

      // build a reusable mention to user that invoked bot
      const mention = {
        mentioned: context.activity.from,
        text: `<at>${new TextEncoder().encode(
          context.activity.from.name
        )}</at>`,
        type: "mention",
      };

      // Trigger command by IM text
      switch (txt) {
        case "start office hour": {
          if (this.activeQueue) {
            await context.sendActivity(
              'Office hour already in progress. End active office hour with the command "end office hour"'
            );
          } else {
            this.activeQueue = new Queue({
              ownerId: context.activity.from.id,
              channelId: context.activity.channelId,
            });
            const queue = await addQueueToDb(
              this.dbConnection,
              this.activeQueue
            );
            this.activeQueue.updateId(queue.id);
            await context.sendActivity(
              "Office hours have started! Use the bot command <b>join office hours</b> to get in line\n\n"
            );
          }
          break;
        }
        case "end office hour": {
          if (this.activeQueue) {
            this.activeQueue.updateStatus(QueueStatus.Closed);
            await updateQueueStatusInDb(this.dbConnection, this.activeQueue);
            this.activeQueue = null;
            await context.sendActivity("Office hour successfully ended.");
          } else {
            await context.sendActivity(
              'No office hour currently active. Start an office hour with the command "start office hour"'
            );
          }
          break;
        }
        case "leave office hours": {
          if (this.activeQueue) {
            if (!this.activeQueue.checkQueue(context.activity.from.id)) {
              const replyActivity = MessageFactory.text(
                `Hello ${mention.text}! Unable to remove, you are currently not in a queue.`
              );
              replyActivity.entities = [mention];
              await context.sendActivity(replyActivity);
            } else {
              this.activeQueue.dequeueStudent(context.activity.from.id);
              const replyActivity = MessageFactory.text(
                `Hello ${mention.text}! You have successfully been removed from the queue.`
              );
              replyActivity.entities = [mention];
              await context.sendActivity(replyActivity);
            }
          } else {
            const replyActivity = MessageFactory.text(
              `Hello ${mention.text}! Currently no office hours being held. Please check the schedule to confirm the next office hours session!`
            );
            replyActivity.entities = [mention];
            await context.sendActivity(replyActivity);
          }
          break;
        }
        case "get queue position": {
          if (this.activeQueue) {
            if (!this.activeQueue.checkQueue(context.activity.from.id)) {
              await context.sendActivity(
                "You are currently not in line for office hours!"
              );
            } else {
              const mention = {
                mentioned: context.activity.from,
                text: `<at>${new TextEncoder().encode(
                  context.activity.from.name
                )}</at>`,
                type: "mention",
              };
              const replyActivity = MessageFactory.text(
                `Hello ${mention.text}! You are currently in position ${
                  this.activeQueue.getQueuePosition(context.activity.from.id) +
                  1
                }.`
              );
              replyActivity.entities = [mention];
              await context.sendActivity(replyActivity);
            }
          } else {
            await context.sendActivity(
              "Currently no office hours being held. Please check the schedule to confirm the next office hours session!"
            );
          }
          break;
        }
        case "my office hours": {
          const queues = await fetchQueuesByOwner(
            this.dbConnection,
            context.activity.from.id,
            context.activity.channelId
          );
          const queueObjects = queues.map((queueEntity) =>
            Queue.fromQueueEntity(queueEntity)
          );
          queueObjects.forEach(
            async (queue) =>
              await context.sendActivity(queue.propertiesToString())
          );
          break;
        }
        case "view active queue": {
          try {
            const teamMembers = await getNamesOfTeamMembers(context);
            if (this.activeQueue) {
              const queueMembers =
                this.activeQueue.getNamesInQueue(teamMembers);
              await context.sendActivity(queueMembers);
            } else {
              await context.sendActivity("No office hour currently active!");
            }
          } catch (e) {
            console.error('Error performing command "view queue"\n' + e);
            throw e;
          }
          break;
        }
        case "mark student complete": {
          // only one student at a time can be in a conversing state
          const studentToUpdate: QueueEntry =
            this.activeQueue.findFirstConversing();
          if (studentToUpdate != undefined && !this.activeQueue.isEmpty()) {
            studentToUpdate.setResolvedState(StudentStatus.Resolved);
            const updateResult = await updateQueueEntryResolved(
              this.dbConnection,
              studentToUpdate.id,
              studentToUpdate.resolved
            );

            const member = await TeamsInfo.getMember(
              context,
              studentToUpdate.userId
            );
            this.activeQueue.dequeueStudent(context.activity.from.id);
            await context.sendActivity(
              `Conversation with ${member.name} is finished and he/she is removed from the queue.`
            );
          } else {
            await context.sendActivity(
              "Unable to mark student as completed - there are either no students conversing with an instructor or no students are in line."
            );
          }
          break;
        }
        case "get next student": {
          const anyConversing: QueueEntry =
            this.activeQueue.findFirstConversing();
          if (anyConversing != undefined) {
            await context.sendActivity(
              `Have you finished helping the other student? Please resolve the conversation with the current student via 'mark student complete'. Currently needs resolving: ${anyConversing.toString()}`
            );
          } else if (this.activeQueue.isEmpty()) {
            await context.sendActivity(
              "There are currently no students in line!"
            );
          } else {
            const nextInLine = this.activeQueue.findFirstWaiting();
            if (nextInLine == undefined) {
              await context.sendActivity(
                "There are no students in queue looking for help right now."
              );
              break;
            }
            // mark the next student
            nextInLine.setResolvedState(StudentStatus.Conversing);
            const updateResult = await updateQueueEntryResolved(
              this.dbConnection,
              nextInLine.id,
              nextInLine.resolved
            );
            console.log(`Updated: ${updateResult}`);

            // tag student to inform it is their turn
            const member = await TeamsInfo.getMember(
              context,
              nextInLine.userId
            );
            await context.sendActivity(
              `Next student to be helped is ${member.name}`
            );
            const mention_student = {
              mentioned: member,
              text: `<at>${new TextEncoder().encode(member.name)}</at>`,
            } as Mention;
            const replyActivity = MessageFactory.text(
              `Hello ${mention_student.text}! It is your turn to get help during this office hours. Please chat or call ${mention.text} to get the conversation started.`
            );
            replyActivity.entities = [mention_student, mention];
            await context.sendActivity(replyActivity);
          }
          break;
        }
      }
      if (txt.startsWith("private join office hours")) {
        try {
          const question: string = txt
            .replace("private join office hours", "")
            .trim();
          if (this.activeQueue) {
            if (this.activeQueue.checkQueue(context.activity.from.id)) {
              const replyActivity = MessageFactory.text(
                `Hello ${mention.text}! You are already in queue.`
              );
              replyActivity.entities = [mention];
              await context.sendActivity(replyActivity);
            } else {
              const queueEntryEntity = await addQueueEntryToDb(
                this.dbConnection,
                context.activity.from.id,
                this.activeQueue.properties.id,
                { question, privateEntry: true }
              );
              this.activeQueue.enqueueQueueEntryEntity(queueEntryEntity);
              const replyActivity = MessageFactory.text(
                `Hello ${
                  mention.text
                }! You have entered the office hours queue, the instructor will get to you! You are in position ${
                  this.activeQueue.getQueuePosition(context.activity.from.id) +
                  1
                }.`
              );
              replyActivity.entities = [mention];
              await context.sendActivity(replyActivity);
            }
          } else {
            const replyActivity = MessageFactory.text(
              `Hello ${mention.text}! Currently no office hours being held. Please check the schedule to confirm the next office hours session!`
            );
            replyActivity.entities = [mention];
            await context.sendActivity(replyActivity);
          }
        } catch (e) {
          console.error(
            'Error performing command "private join office hours"\n' + e
          );
          throw e;
        }
      }

      if (txt.startsWith("join office hours")) {
        try {
          const question: string = txt.replace("join office hours", "").trim();
          if (this.activeQueue) {
            if (this.activeQueue.checkQueue(context.activity.from.id)) {
              const replyActivity = MessageFactory.text(
                `Hello ${mention.text}! You are already in queue.`
              );
              replyActivity.entities = [mention];
              await context.sendActivity(replyActivity);
            } else {
              const queueEntryEntity = await addQueueEntryToDb(
                this.dbConnection,
                context.activity.from.id,
                this.activeQueue.properties.id,
                { question, privateEntry: false }
              );
              this.activeQueue.enqueueQueueEntryEntity(queueEntryEntity);
              const replyActivity = MessageFactory.text(
                `Hello ${
                  mention.text
                }! You have entered the office hours queue, the instructor will get to you! You are in position ${
                  this.activeQueue.getQueuePosition(context.activity.from.id) +
                  1
                }.`
              );
              replyActivity.entities = [mention];
              await context.sendActivity(replyActivity);
            }
          } else {
            const replyActivity = MessageFactory.text(
              `Hello ${mention.text}! Currently no office hours being held. Please check the schedule to confirm the next office hours session!`
            );
            replyActivity.entities = [mention];
            await context.sendActivity(replyActivity);
          }
        } catch (e) {
          console.error('Error performing command "join office hours"\n' + e);
          throw e;
        }
      }

      // By calling next() you ensure that the next BotHandler is run.
      await next();
    });
  }
}

export const sendNewMessage = async () => {};

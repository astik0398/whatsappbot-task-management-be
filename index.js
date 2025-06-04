const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { OpenAI } = require("openai");
const supabase = require("./supabaseClient");
require("dotenv").config();
const cron = require("node-cron");
const cors = require("cors");
const { default: axios } = require("axios");
const fs = require("fs");
const FormData = require("form-data"); // to handle file upload
const moment = require("moment-timezone");
const { google } = require("googleapis");
const MessagingResponse = require("twilio").twiml.MessagingResponse;
const chrono = require("chrono-node");
const tinyurl = require("tinyurl");

const app = express();
const port = process.env.PORT || 8000;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const client = new twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

app.use(cors());

const oAuth2Client = new google.auth.OAuth2(
  process.env.CLIENT_ID,
  process.env.CLIENT_SECRET,
  process.env.REDIRECT_URI
);
oAuth2Client.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});
const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

const shortenUrl = async (longUrl) => {
  const shortURL = tinyurl.shorten(longUrl);
  console.log("shortURL", shortURL);
  return shortURL;
};

let allData = [];
let userSessions = {};
let assignerMap = [];
let todayDate = "";
let currentTime = "";

const sessions = {};

const getFormattedDate = () => {
  const today = new Date();
  const options = { year: "numeric", month: "long", day: "numeric" };

  console.log(today.toLocaleDateString("en-US", options));

  return today.toLocaleDateString("en-US", options);
};

const getCurrentDate = () => {
  const now = moment().tz("Asia/Kolkata"); // Explicitly set to Asia/Kolkata
  const year = now.get("year");
  const month = String(now.get("month") + 1).padStart(2, "0");
  const day = String(now.get("date")).padStart(2, "0");
  const hours = String(now.get("hour")).padStart(2, "0");
  const minutes = String(now.get("minute")).padStart(2, "0");

  console.log(`${year}-${month}-${day} ${hours}:${minutes}`);
  return `${year}-${month}-${day} ${hours}:${minutes}`;
};

async function getRefreshToken(userNumber) {
  const { data } = await supabase
    .from("user_tokens")
    .select("refresh_token")
    .eq("phone_number", userNumber)
    .single();
  return data?.refresh_token || null;
}

// Save refresh token
async function saveRefreshToken(userNumber, refreshToken) {
  const { error } = await supabase
    .from("user_tokens")
    .upsert({ phone_number: userNumber, refresh_token: refreshToken });
  return !error;
}

function getOAuthClient(refreshToken) {
  const oAuth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );
  oAuth2Client.setCredentials({ refresh_token: refreshToken });
  return oAuth2Client;
}

const getFormattedTime = () => {
  const now = moment().tz("Asia/Kolkata");
  return now.format("h:mm A");
};

async function getAllTasks() {
  const { data, error } = await supabase.from("grouped_tasks").select("*");
  if (error) throw error;

  return data;
}
async function main() {
  allData = await getAllTasks();
}

main();

app.get("/refresh", async (req, res) => {
  console.log("Refreshing tasks from Supabase...");
  const { data, error } = await supabase.from("grouped_tasks").select("*");
  if (error) {
    console.error("Error refreshing tasks:", error);
    return res.status(500).json({ message: "Error fetching tasks" });
  }
  allData = data;
  res
    .status(200)
    .json({ message: "Tasks refreshed successfully", tasks: allData });
});

async function handleUserInput(userMessage, From) {
  console.log("we are here===> 1");
  const session = userSessions[From];
  const conversationHistory = session.conversationHistory || [];
  conversationHistory.push({ role: "user", content: userMessage });
  console.log("we are here===> 2");

  assignerMap.push(From);

  console.log("assigner Map===> 0", assignerMap);

  if (session.step === 5) {
    if (userMessage.toLowerCase() === "yes") {
      const taskId = session.taskId; // Now using taskId instead of task name
      const assignee = session.assignee;

      console.log("INSIDE SESSION.SETP 5, USER TYPES YES", session);
      console.log("FROM====>", From);

      const { data, error } = await supabase
        .from("grouped_tasks")
        .select("tasks")
        .eq("name", assignee.toUpperCase())
        .eq("employerNumber", session.fromNumber)
        .single();

      if (error) {
        console.error("Error fetching tasks:", error);
        sendMessage(From, "Sorry, there was an error accessing the task.");
        return;
      }

      const updatedTasks = data.tasks.map((task) =>
        task.taskId === taskId ? { ...task, task_done: "Completed" } : task
      );

      console.log("updatedTasks --->", updatedTasks);

      const { error: updateError } = await supabase
        .from("grouped_tasks")
        .update({ tasks: updatedTasks })
        .eq("name", assignee.toUpperCase())
        .eq("employerNumber", session.fromNumber);

      console.log("assigner Map===> 1", assignerMap);

      if (updateError) {
        console.error("Error updating task:", updateError);
        sendMessage(
          From,
          "Sorry, there was an error marking the task as completed."
        );
      } else {
        sendMessage(
          From,
          "Thank you! The task has been marked as completed! ✅"
        );
        sendMessage(
          session.fromNumber,
          `The task *${session.task}* assigned to *${session.assignee}* was completed. ✅`
        );

        cronJobs.get(taskId)?.stop();
        cronJobs.delete(taskId);
      }

      delete userSessions[From];
    } else if (userMessage.toLowerCase() === "no") {
      sendMessage(
        From,
        "⚠️ Why has the task not been completed? Please provide a reason."
      );

      session.step = 6;
    } else {
      sendMessage(From, "Please respond with 'Yes' or 'No'.");
    }
  } else if (session.step === 6) {
    console.log("session --- >", session);

    const reason = userMessage.trim();
    const task = session.task;
    const assignee = session.assignee;
    const taskId = session.taskId;

    console.log("assignee----session====>", assignee);

    const { data, error } = await supabase
      .from("grouped_tasks")
      .select("tasks")
      .eq("name", assignee.toUpperCase())
      .eq("employerNumber", session.fromNumber)
      .single();

    if (error) {
      console.error("Error fetching tasks:", error);
      sendMessage(From, "Sorry, there was an error accessing the task.");
      return;
    }

    const updatedTasks = data.tasks.map((task) =>
      task.taskId === taskId
        ? { ...task, task_done: "Not Completed", reason }
        : task
    );

    console.log("updatedTasks --->", updatedTasks);

    const { error: updateError } = await supabase
      .from("grouped_tasks")
      .update({ tasks: updatedTasks })
      .eq("name", assignee.toUpperCase())
      .eq("employerNumber", session.fromNumber);

    console.log("assigner Map===> 2", assignerMap);

    if (updateError) {
      console.error("Error updating task with reason:", updateError);
      sendMessage(From, "Sorry, there was an error saving the reason. ⚠️");
    } else {
      sendMessage(From, "📤 Your response has been sent to the assigner.");
      sendMessage(
        session.fromNumber,
        `⚠️ *Task Not Completed*\n\nThe task *${session.task}* assigned to *${
          session.assignee
        }* was not completed.\n📝 *Reason:* ${reason.trim()}`
      );
    }

    delete userSessions[From];
  } else {
    const prompt = `
You are a helpful task manager assistant. Respond with a formal tone and
a step-by-step format.
Your goal is to guide the user through task assignment:
- Ask for task details (task, assignee, due date, time, and reminder preference).
- The reminder preference can be either:
  - A recurring reminder (e.g., "every 3 mins", "every 2 hours", "every 1 day").
  - A one-time reminder (e.g., "one-time on 20th May at 5PM").
- For one-time reminders, explicitly ask for the reminder date and time (e.g., "When would you like the one-time reminder to be sent? For example, '20th May at 5PM'.").  
- Respond to yes/no inputs appropriately.
- Follow up if any information is incomplete.
- Keep the respone concise and structured.
- Once you have all the details please **summarize** the entered details

EXAMPLES: 

- If a user is asked about due date, due time, and reminder preference, and they send only due date and due time, ask for reminder preference.
- If a user is asked about due date, due time and reminder frequncy, and user sends only due date and due time then it should again ask for reminder frequency and should not ignore that.
- If a user selects a one-time reminder but doesn't provide a reminder date and time, ask for the reminder date and time explicitly.
- Similarly if a user is asked about task, assignee and due date but user only only task and due date then it should again ask the user asking about the assignee since they did not sent that.

IMPORTANT:
- Once all details are collected, return **ONLY** with a JSON object which will be used for backend purpose.
- Do **not** include any extra text before or after the JSON.
- This is only for backend procesing so do **NOT** send this JSON
format to user
- The JSON format should be:
{
"task": "<task_name>",
"assignee": "<assignee_name>",
"dueDate": "<YYYY-MM-DD>",
"dueTime": "<HH:mm>",
"reminder_type": "<recurring|one-time>",
"reminder_frequency": "<reminder_frequency or null for one-time>",
"reminderDateTime": "<YYYY-MM-DD HH:mm or null for recurring>"
}
- For one-time reminders, set reminder_type to "one-time", reminder_frequency to null, and reminderDateTime to the user-specified reminder date and time in "YYYY-MM-DD HH:mm" format.
- For recurring reminders, set reminderDateTime to null.
- Do **not** assume the reminder time is tied to the due date for one-time reminders; it should be based on user input (e.g., "20th May at 5PM").

After having all the details you can send the summary of the response so
that user can have a look at it.
For due dates:
- If the user provides a day and month (e.g., "28th Feb" or "28 February"),
convert it into the current year (e.g., "2025-02-28").
- If the user provides a full date (e.g., "28th Feb 2025"), return it as is.
- If no year is provided, assume the current year which is 2025 and return
the date in the format YYYY-MM-DD.

For dynamic date terms:
- Today's date is ${todayDate}
- If the user says "today," convert that into **the current date** (e.g., if today is April 5, 2025, it should return "2025-04-05").
- If the user says "tomorrow," convert that into **the next day’s date** (e.g., if today is April 5, 2025, "tomorrow" should be "2025-04-06").
- If the user says "next week," calculate the date of the same day in the following week (e.g., if today is April 5, 2025, "next week" would be April 12, 2025).
- If the user provides a phrase like "in X days," calculate the due date accordingly (e.g., "in 3 days" should become "2025-04-08").
- If the user provides terms like "next month," calculate the due date for the same day of the next month (e.g., if today is April 5, 2025, "next month" should become "2025-05-05").

For due times:
- Current time is ${currentTime}
- If the user provides a time in "AM/PM" format (e.g., "6 PM" or "6 AM"),
convert it into the 24-hour format:
- "6 AM" becomes "06:00"
- "6 PM" becomes "18:00"
- Ensure the output time is always in the 24-hour format (HH:mm).
- If the user says "next X hours" or "in X minutes," calculate the **current time** accordingly(e.g., if current time is 5:40 pm then "next 5 hours" will be 10:40 pm).

Conversation history: ${JSON.stringify(conversationHistory)}
User input: ${userMessage}
`;
    console.log("we are here===> 3");
    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4-turbo",
        messages: [{ role: "system", content: prompt }],
      });
      console.log("we are here===> 4");
      const botReply = response.choices[0].message.content;
      session.conversationHistory = conversationHistory;
      console.log("we are here===> 5", botReply);

      if (botReply[0] === "{") {
        const taskDetails = JSON.parse(botReply);

        const assigneeName = taskDetails.assignee.trim();

        console.log("assigneeName====>", assigneeName);

        const { data: matchingAssignees, error } = await supabase
          .from("grouped_tasks")
          .select("*")
          .ilike("name", `%${assigneeName}%`)
          .eq("employerNumber", From);

        if (error) {
          console.error("Error fetching assignees:", error);
          sendMessage(
            From,
            "Sorry, there was an error fetching the assignee data."
          );
          return;
        }

        console.log("FROM NUMBER===>", From);

        console.log("matchingAssignees====>", matchingAssignees);

        if (matchingAssignees.length > 1) {
          let message = `There are multiple people with the name "${assigneeName}". Please choose one:\n`;
          matchingAssignees.forEach((assignee, index) => {
            message += `${index + 1}. ${assignee.name}\n`;
          });
          console.log("message-new===>", message);

          sendMessage(From, message);
          session.step = 7;
          session.possibleAssignees = matchingAssignees;
          return;
        }

        sendMessage(
          From,
          `✅ *Task Summary*
Thank you for providing the task details! Here's a quick summary:

📝 *Task:* ${taskDetails.task}
👤 *Assignee:* ${taskDetails.assignee.toUpperCase()}
📅 *Due Date:* ${taskDetails.dueDate}
⏰ *Due Time:* ${taskDetails.dueTime}
🔁 *Reminder:* ${
            taskDetails.reminder_type === "one-time"
              ? `One-time at ${taskDetails.reminderDateTime}`
              : `Recurring ${taskDetails.reminder_frequency}`
          }`
        );
      } else {
        sendMessage(From, botReply);
      }

      if (botReply[0] === "{") {
        try {
          const taskData = JSON.parse(botReply);
          const assignedPerson = allData.find(
            (person) =>
              person.name.toLowerCase() === taskData.assignee.toLowerCase() &&
              person.employerNumber === From
          );
          console.log("assignedPerson--->", assignedPerson);
          console.log("taskData", taskData);
          if (assignedPerson) {
            let dueDateTime = `${taskData.dueDate} ${taskData.dueTime}`;
            if (
              taskData.task &&
              taskData.assignee &&
              taskData.dueDate &&
              taskData.dueTime
            ) {
              const newTask = {
                taskId: Date.now().toString(), // Simple ID generation; consider UUID for production
                task_details: taskData.task,
                task_done: "Pending",
                due_date: dueDateTime,
                reminder: "true",
                reminder_frequency: taskData.reminder_frequency,
                reason: null,
                started_at: getCurrentDate(),
                reminder_type: taskData.reminder_type || "recurring", // Default to recurring if not specified
                reminderDateTime: taskData.reminderDateTime || null, // Store reminder date and time
              };

              const { data: existingData, error: fetchError } = await supabase
                .from("grouped_tasks")
                .select("tasks")
                .eq("name", taskData.assignee.toUpperCase())
                .eq("employerNumber", From)
                .single();

              if (fetchError) {
                console.error("Error fetching existing tasks:", fetchError);
                sendMessage(From, "Error accessing assignee tasks.");
                return;
              }

              const updatedTasks = existingData.tasks
                ? [...existingData.tasks, newTask]
                : [newTask];

              const { data, error } = await supabase
                .from("grouped_tasks")
                .update({ tasks: updatedTasks })
                .eq("name", taskData.assignee.toUpperCase())
                .eq("employerNumber", From)
                .select();

              console.log("Matching Task:", data, error);
              if (error) {
                console.error("Error inserting task into Supabase:", error);
                sendMessage(From, "Error saving the task.");
              } else {
                console.log("Task successfully added to Supabase.");
                sendMessage(
                  From,
                  `📌 *Task Assigned*\n\nA new task, *${
                    taskData.task
                  }* has been assigned to *${taskData.assignee.toUpperCase()}*\n🗓️ *Due Date:* ${dueDateTime}`
                );
                sendMessage(
                  `whatsapp:+${assignedPerson.phone}`,
                  `📬 *New Task Assigned!*\n\nHello *${taskData.assignee.toUpperCase()}*,\nYou've been assigned a new task:\n\n📝 *Task:* *${
                    taskData.task
                  }*\n📅 *Deadline:* ${dueDateTime}`
                );
                delete userSessions[From];
                session.conversationHistory = [];

                await fetch(
                  "https://whatsappbot-task-management-be-production.up.railway.app/update-reminder",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      reminder_frequency: taskData.reminder_frequency,
                      taskId: newTask.taskId,
                      reminder_type: taskData.reminder_type || "recurring",
                      dueDateTime: dueDateTime, // Pass due date for one-time reminders
                      reminderDateTime: taskData.reminderDateTime,
                    }),
                  }
                )
                  .then((res) => res.json())
                  .then((response) => {
                    console.log("taskID for reminder--->", newTask.taskId);

                    console.log("Reminder endpoint response:", response);
                  })
                  .catch((error) => {
                    console.error("Error triggering reminder endpoint:", error);
                  });
              }
            }
          } else {
            sendMessage(From, "Error: Could not find assignee.");
          }
        } catch (parseError) {
          console.error("Error parsing task details:", parseError);
        }
      }
    } catch (error) {
      console.error("Error processing user input with ChatGPT:", error);
      sendMessage(
        From,
        "Sorry, I couldn't process your message right now. Please try again."
      );
    }
  }
}

function sendMessage(to, message) {
  console.log("Sending message to:", to);
  console.log("Message:", message);
  client.messages
    .create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body: message,
    })
    .then((message) => {
      console.log("Message sent successfully:", message.sid);
    })
    .catch((err) => {
      console.error("Error sending message:", err);
      if (err.code) {
        console.error("Twilio error code:", err.code);
      }
    });
}

async function transcribeAudioDirectly(mediaUrl) {
  try {
    // Twilio's Account SID and Auth Token
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    // Create Basic Auth header
    const authHeader =
      "Basic " + Buffer.from(accountSid + ":" + authToken).toString("base64");

    const mediaResponse = await axios.get(mediaUrl, {
      responseType: "arraybuffer",
      auth: {
        username: accountSid,
        password: authToken,
      },
    });

    const form = new FormData();
    form.append("file", Buffer.from(mediaResponse.data), {
      filename: "audio.mp3",
      contentType: "audio/mp3",
    });
    form.append("model", "whisper-1");
    form.append("task", "translate");
    form.append("language", "hi");

    // Send directly to OpenAI Whisper for transcription
    const result = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      }
    );

    if (result && result.data) {
      console.log("Transcription result nwestttt======>:", result.data);
      return result.data.text;
    } else {
      console.log("No transcription result returned");
      return null;
    }
  } catch (error) {
    console.error(
      "Error transcribing audio:",
      error.response ? error.response.data : error.message
    );
    return null;
  }
}

async function makeTwilioRequest() {
  app.post("/whatsapp", async (req, res) => {
    const { Body, From } = req.body;

    todayDate = getFormattedDate();
    currentTime = getFormattedTime();

    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0;

    let userMessage = Body.trim();

    let incomingMsg = Body.trim();

    const userNumber = req.body.From;

    if (
      incomingMsg.toLowerCase().includes("schedule") ||
      (sessions[userNumber] && sessions[userNumber].pendingMeeting)
    ) {
      console.log("MEETING FUNC TRIGGERED!!!");

      const userMsg = req.body.Body;

      const refreshToken = await getRefreshToken(userNumber);

      if (!refreshToken) {
        const authUrl = new google.auth.OAuth2(
          process.env.CLIENT_ID,
          process.env.CLIENT_SECRET,
          process.env.REDIRECT_URI
        ).generateAuthUrl({
          access_type: "offline",
          prompt: "consent",
          scope: ["https://www.googleapis.com/auth/calendar"],
          state: `whatsapp:${userNumber}`,
        });

        const twiml = new MessagingResponse();
        twiml.message(
          `📅 Ready to schedule your meeting? Sign in with Google to continue: ${await shortenUrl(
            authUrl
          )} 🛡️`
        );
        return res.type("text/xml").send(twiml.toString());
      }

      // Initialize session if not exists
      if (!sessions[userNumber]) {
        sessions[userNumber] = {
          history: [
            {
              role: "system",
              content: `You are a helpful assistant that schedules meetings using Google Calendar.More actions

Your task is to first analyze the user's message and check if it contains all required information to schedule a meeting:
- Email of the invitee
- Title or topic of the meeting
- Date of the meeting
- Start time of the meeting (must include AM/PM unless it's clearly 24-hour format)
- Duration of the meeting
- Meeting type (one-time or recurring)
- For recurring meetings: recurrence frequency (e.g., daily, weekly, monthly) and optional end date (e.g., "until 31st Dec 2025")

You MUST check for missing or ambiguous fields. Be especially strict about time ambiguity:
- If a time like "8" or "tomorrow 8" is mentioned without AM/PM, ask the user to clarify.
- Never assume AM or PM.
- Phrases like "8", "5", or "at 3" without a clear indication of AM/PM or 24-hour format should be considered ambiguous.
- If the year is missing in date of the meeting always assume the year as current year which is ${new Date().getFullYear()}

For the meeting title:
- Automatically detect and correct any typos or spelling errors in the title without asking the user for confirmation.
- Use natural language understanding to infer the intended meaning and correct to standard English.
- Example: If the user provides "Validte the authtictio proces", correct it to "Validate the authentication process" in the JSON output.

For recurring meetings:
- Ask the user if the meeting is one-time or recurring.
- If recurring, ask for the frequency (e.g., "daily", "weekly", "monthly") and an optional end date (e.g., "until 31st Dec 2025").
- If the user doesn’t specify an end date, assume the meeting recurs for one year from the start date.
- Convert recurrence frequency to Google Calendar RRULE format (e.g., "daily" -> "RRULE:FREQ=DAILY", "weekly" -> "RRULE:FREQ=WEEKLY", "monthly" -> "RRULE:FREQ=MONTHLY", "weekend" -> "RRULE:FREQ=WEEKLY;BYDAY=SA,SU", "weekday" -> "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR").
- If an end date is provided, include it in the RRULE (e.g., "RRULE:FREQ=WEEKLY;UNTIL=20251231T235959Z").
- Accept natural language like "every weekend", "on weekends", "every Saturday and Sunday" as frequency 'weekend'

For dynamic date terms:
- Today's date is ${todayDate}.
- If the user says "today," convert that into **the current date** (e.g., if today is April 5, 2025, it should return "2025-04-05").
- If the user says "tomorrow," convert that into **the next day’s date** (e.g., if today is April 5, 2025, "tomorrow" should return "2025-04-06").
- If the user says "next week," calculate the date of the same day in the following week (e.g., if today is April 5, 2025, "next week" would return "2025-04-12").
- If the user says "in X days," calculate the due date accordingly (e.g., "in 3 days" should return "2025-04-08").
- If the user says "next month," calculate the due date for the same day of the next month (e.g., if today is April 5, 2025, "next month" should return "2025-05-05").

For dynamic time terms:
- Current time is ${currentTime}.
- If the user says "next X hours" or "in X minutes," calculate the **current time** accordingly (e.g., if the current time is 5:40 PM, then "next 5 hours" will be 10:40 PM).

If anything is unclear or missing, respond with a plain text clarification question. For example:
- "I noticed you said 'tomorrow 8'. Did you mean 8 AM or 8 PM? Please reply with the exact time."
- For ambiguous time: "I noticed you mentioned '100pm' for the meeting time. Did you mean 1:00 PM? Please provide the exact time in HH:mm AM/PM format or 24-hour format (e.g., 13:00)."

If the message is clear, contains all the required fields (invitee email, meeting title, date, time with AM/PM, and duration), and there is no ambiguity, proceed to schedule the meeting **immediately** without sending a confirmation or asking the user to respond again.

Do NOT reply with a summary or confirmation message if all the required fields are present and unambiguous. Simply schedule the meeting silently.

When all details are collected, return **ONLY** a JSON object with the following schema:
{
  "title": "<meeting_title>",
  "date": "<YYYY-MM-DD>",
  "startTime": "<HH:mm>",
  "durationMinutes": <number>,
  "attendees": ["<email1>", "<email2>", ...],More actions
  "meetingType": "<one-time|recurring>",
  "recurrenceFrequency": "<daily|weekly|monthly|null>",
  "recurrenceEndDate": "<YYYY-MM-DD|null>"
}
`,
            },
          ],
          pendingMeeting: false,
        };
      }

      // Push user message to session
      sessions[userNumber].history.push({ role: "user", content: userMsg });

      // Generate reply with full context
      const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: sessions[userNumber].history,
        functions: [
          {
            name: "create_calendar_event",
            parameters: {
              type: "object",
              properties: {
                title: { type: "string" },
                date: { type: "string", format: "date" },
                startTime: { type: "string" },
                durationMinutes: { type: "number" },
                attendees: {
                  type: "array",
                  items: { type: "string", format: "email" },
                },
                meetingType: {
                  type: "string",
                  enum: ["one-time", "recurring"],
                }, // NEW
                recurrenceFrequency: {
                  type: ["string", "null"],
                  enum: [
                    "daily",
                    "weekly",
                    "monthly",
                    "weekday",
                    "weekend",
                    null,
                  ],
                }, // NEW
                recurrenceEndDate: { type: ["string", "null"], format: "date" },
              },
              required: [
                "title",
                "date",
                "startTime",
                "durationMinutes",
                "meetingType",
              ],
            },
          },
        ],
        function_call: "auto",
      });

      const gptReply = completion.choices[0].message;

      // Save assistant message for context continuity
      sessions[userNumber].history.push(gptReply);

      // If function call is not triggered yet, GPT is asking for more info
      if (!gptReply.function_call) {
        sessions[userNumber].pendingMeeting = true;

        const twiml = new MessagingResponse();
        twiml.message(gptReply.content || "Could you provide more details?");
        return res.type("text/xml").send(twiml.toString());
      }

      const args = JSON.parse(gptReply.function_call.arguments);
      const {
        title,
        date,
        startTime,
        durationMinutes,
        attendees = [],
        meetingType,
        recurrenceFrequency,
        recurrenceEndDate,
      } = args;

      delete sessions[userNumber];

      const naturalInput = `${date} ${startTime}`;

      const parsedDateTime = chrono.parseDate(naturalInput, new Date());

      if (!parsedDateTime) {
        const twiml = new MessagingResponse();
        twiml.message(
          "⚠️ Couldn't understand the date and time. Please try again with a specific time and date like 'April 12 at 14:00'."
        );
        return res.type("text/xml").send(twiml.toString());
      }

      // ✅ Convert parsed time to IST using moment-timezone
      const startDateTime = moment(parsedDateTime);
      const endDateTime = startDateTime.clone().add(durationMinutes, "minutes");

      const oAuth2Client = getOAuthClient(refreshToken);
      const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

      console.log("Parsed values from OpenAI:");
      console.log("Title:", title);
      console.log("Date:", date);
      console.log("startDateTime:", startDateTime.toISOString());
      console.log("endDateTime:", endDateTime.toISOString());
      console.log("Start Time:", startTime);
      console.log("Duration (mins):", durationMinutes);
      console.log("Attendees:", attendees);
      console.log("Meeting Type:", meetingType); // NEW
      console.log("Recurrence Frequency:", recurrenceFrequency); // NEW
      console.log("Recurrence End Date:", recurrenceEndDate); // NEW

      const event = {
        summary: title,
        start: {
          dateTime: startDateTime.format("YYYY-MM-DDTHH:mm:ss"), // ⬅️ key change
          timeZone: "Asia/Kolkata",
        },
        end: {
          dateTime: endDateTime.format("YYYY-MM-DDTHH:mm:ss"), // ⬅️ key change
          timeZone: "Asia/Kolkata",
        },
        attendees: attendees.map((email) => ({ email })),
        conferenceData: {
          createRequest: {
            requestId: Math.random().toString(36).substring(2),
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      };

      // Add recurrence rule for recurring meetings
      if (meetingType === "recurring") {
        if (!recurrenceFrequency || !recurrenceEndDate) {
          const twiml = new MessagingResponse();
          twiml.message(
            `⚠️ ${
              !recurrenceFrequency
                ? "Please specify the recurrence frequency (e.g., daily, weekly, monthly, weekday)."
                : "Please provide an end date for the recurring meeting (e.g., 'until 31st Dec 2025')."
            }`
          );
          return res.type("text/xml").send(twiml.toString());
        }

        let rrule = "";
        if (recurrenceFrequency === "weekday") {
          rrule = `RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`;
        } else if (recurrenceFrequency === "weekend") {
          rrule = `RRULE:FREQ=WEEKLY;BYDAY=SA,SU`; // ✅ ADD THIS
        } else {
          rrule = `RRULE:FREQ=${recurrenceFrequency.toUpperCase()}`;
        }
        // Convert recurrenceEndDate to UTC for RRULE
        const endDate =
          moment
            .tz(recurrenceEndDate, "YYYY-MM-DD", "Asia/Kolkata")
            .endOf("day") // Set to 23:59:59 in Asia/Kolkata
            .utc() // Convert to UTC
            .format("YYYYMMDDTHHmmss") + "Z"; // Format as YYYYMMDDTHHMMSSZ
        rrule += `;UNTIL=${endDate}`;
        event.recurrence = [rrule];
        console.log("Generated RRULE:", rrule);
      }

      let calendarResponse;
      try {
        calendarResponse = await calendar.events.insert({
          calendarId: "primary",
          resource: event,
          conferenceDataVersion: 1,
          sendUpdates: "all",
        });
      } catch (error) {
        console.error("Calendar error:", error);
        const twiml = new MessagingResponse();
        twiml.message("Failed to create calendar invite. Try again.");
        return res.type("text/xml").send(twiml.toString());
      }

      const twiml = new MessagingResponse();

      let message = `✅ Meeting successfully created! 🎉\n📝 *Title:* ${title}\n📅 *Date:* ${startDateTime.format(
        "ddd MMM DD YYYY"
      )}\n🕒 *Time:* ${startDateTime.format("h:mm A")} IST\n🔗 *Link:* ${
        calendarResponse.data.hangoutLink
      }`;

      if (meetingType === "recurring") {
        message += `\n🔁 *Recurrence:* ${recurrenceFrequency}`;
        if (recurrenceEndDate) {
          message += ` until ${moment(recurrenceEndDate).format(
            "MMM DD, YYYY"
          )}`;
        } else {
          message += ` for one year`;
        }
      }
      twiml.message(message); // MODIFIED
      return res.type("text/xml").send(twiml.toString());
    }

    console.log("mediaUrl - mediaType", mediaUrl, mediaType);

    if (mediaUrl && mediaType && mediaType.startsWith("audio")) {
      console.log(`Received a voice message from`);
      console.log(`Media URL: ${mediaUrl}`);

      const transcription = await transcribeAudioDirectly(mediaUrl);

      if (transcription) {
        userMessage = transcription;
      }

      const apiKey = process.env.WORDWARE_API_KEY;
      const requestBody = {
        inputs: {
          your_text: userMessage,
        },
        version: "^2.0",
      };

      const response = await axios.post(
        "https://app.wordware.ai/api/released-app/8ab2f459-fee3-4aa1-9d8b-fc6454a347c3/run",
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
        }
      );

      console.log("res====?>", response.data);

      const responseValue = response.data.trim().split("\n");

      let parsedChunks = responseValue.map((chunk) => JSON.parse(chunk));

      console.log(
        "parsedChunks length",
        parsedChunks[parsedChunks.length - 1].value.values.new_generation
      );

      const cleanText =
        parsedChunks[parsedChunks.length - 1].value.values.new_generation;

      console.log("clean text====>", cleanText);

      userMessage = cleanText;
    }

    // Respond with an HTTP 200 status
    res.status(200).send("<Response></Response>");

    if (!userSessions[From]) {
      userSessions[From] = {
        step: 0,
        task: "",
        assignee: "",
        dueDate: "",
        dueTime: "",
        assignerNumber: From,
        conversationHistory: [],
      };
    }
    console.log(userMessage, From);
    await handleUserInput(userMessage, From);
    res.end();
  });
}

app.get("/auth/google/callback", async (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  if (!code || !state || !state.startsWith("whatsapp:")) {
    return res.send("Invalid request");
  }

  const userNumber = state.replace("whatsapp:", "");
  const oAuth2Client = new google.auth.OAuth2(
    process.env.CLIENT_ID,
    process.env.CLIENT_SECRET,
    process.env.REDIRECT_URI
  );

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    if (!tokens.refresh_token) {
      return res.send("❌ Google didn't return a refresh token. Try again.");
    }

    console.log("tokens", tokens);

    const saved = await saveRefreshToken(userNumber, tokens.refresh_token);
    if (!saved) return res.send("❌ Failed to save token.");

    return res.send(
      `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Authentication Success</title>
    <style>
      body {
        display: flex;
        justify-content: center;
        align-items: center;
        height: 100vh;
        margin: 0;
        font-family: Arial, sans-serif;
        background-color: #f0f0f0;
      }
      .card {
        background-color: #ffffff; /* Changed to white background */
        color: #333; /* Changed text color for contrast */
        padding: 20px;
        border-radius: 10px;
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
        text-align: center;
        max-width: 45%;
      }
      .card img {
        width: 150px;
        height: 150px;
        vertical-align: middle;
        margin-right: 10px;
      }

      .continue-button {
        background-color: #4CAF50;
        color: white;
        border: none;
        padding: 10px 30px;
        text-align: center;
        text-decoration: none;
        display: inline-block;
        font-size: 16px;
        font-weight: bold;
        border-radius: 8px;
        cursor: pointer;
        transition: background-color 0.3s ease, transform 0.2s ease;
        margin-top: 15px;
    }

    .continue-button:hover {
        background-color: #45a049;
        transform: scale(1.05);
    }

    .continue-button:active {
        background-color: #3e8e41;
        transform: scale(0.98);
    }
    </style>
  </head>
  <body>
    <div class="card">
      <div>
        <img src="https://rxmjzmgvxbotzfqhidzd.supabase.co/storage/v1/object/public/images//thumbsup.png" alt="Thumbs Up" />
      </div>

      <div>
        <h2>✅ Authentication Successful! 🎉<br /></h2>

        <h3 style="font-size: 25px;">
            You can now schedule any meetings on WhatsApp 📅📱
        </h3>
      </div>

      <div>
        <a href="https://wa.me/15557083934" target="_blank">
            <button class="continue-button">👉 Continue</button>
        </a>
    </div>
    </div>
  </body>
</html>`
    );
  } catch (err) {
    console.error("OAuth error:", err.message);
    res.send("❌ Failed to authenticate with Google.");
  }
});

let isCronRunning = false; // Track if the cron job is active
const cronJobs = new Map(); // Map to store cron jobs for each task

app.post("/update-reminder", async (req, res) => {
  const {
    reminder_type,
    reminder_frequency,
    taskId,
    dueDateTime,
    reminderDateTime,
  } = req.body;

  console.log("inside be update-reminder req.body", req.body);

  if (cronJobs.has(taskId)) {
    console.log(
      `Cron job already exists for task ${taskId}. Ignoring duplicate trigger.`
    );
    return res.status(200).json({ message: "Reminder already scheduled" });
  }

  const sendReminder = async () => {
    console.log(`Checking reminder for task ${taskId}...`);

    const { data: groupedData, error } = await supabase
      .from("grouped_tasks")
      .select("name, phone, tasks, employerNumber");

    if (error) {
      console.error("Error fetching grouped_tasks", error);
      return;
    }

    const matchedRow = groupedData.find((row) =>
      row.tasks?.some((task) => task.taskId === taskId)
    );

    console.log("matchedRow===>", matchedRow);

    if (!matchedRow) {
      console.log(
        `No matching task found for task ${taskId}. Stopping reminder.`
      );
      cronJobs.get(taskId)?.stop();
      cronJobs.delete(taskId);
      return;
    }

    const matchedTask = matchedRow.tasks.find((task) => task.taskId === taskId);

    console.log("matchedTask===>", matchedTask);

    if (
      matchedTask.reminder !== "true" ||
      matchedTask.task_done === "Completed" ||
      matchedTask.task_done === "No" ||
      matchedTask.task_done === "Reminder sent" ||
      !matchedTask.task_details
    ) {
      console.log(
        `Task ${taskId} doesn't need reminder anymore. Stopping reminder.`
      );
      cronJobs.get(taskId)?.stop();
      cronJobs.delete(taskId);
      return;
    }

    console.log(`Sending reminder to: ${matchedRow.phone} for task ${taskId}`);

    // send TEMPORARY due date and time for one-time reminders
    sendMessage(
      `whatsapp:+${matchedRow.phone}`,
      `⏰ *Reminder*\n\nHas the task *${matchedTask.task_details}* assigned to you been completed yet?\n✉️ Reply with Yes or No.\n📅 *Due:* ${matchedTask.due_date}`
    );

    userSessions[`whatsapp:+${matchedRow.phone}`] = {
      step: 5,
      task: matchedTask.task_details,
      assignee: matchedRow.name,
      fromNumber: matchedRow.employerNumber,
      taskId: taskId,
    };

    // For one-time reminders, mark task to stop further reminders
    if (reminder_type === "one-time") {
      console.log("inside ONE-TIME reminder===>", matchedRow.employerNumber);

      const { data: existingData } = await supabase
        .from("grouped_tasks")
        .select("tasks")
        .eq("name", matchedRow.name.toUpperCase())
        .eq("employerNumber", matchedRow.employerNumber)
        .single();

      console.log("inside ONE-TIME reminder existing data==>", existingData);

      const updatedTasks = existingData.tasks.map((task) =>
        task.taskId === taskId ? { ...task, reminder: "false" } : task
      );

      console.log("inside ONE-TIME reminder", updatedTasks);
      console.log("inside ONE-TIME reminder===>", matchedRow.employerNumber);

      await supabase
        .from("grouped_tasks")
        .update({ tasks: updatedTasks })
        .eq("name", matchedRow.name.toUpperCase())
        .eq("employerNumber", matchedRow.employerNumber);

      cronJobs.delete(taskId); // Clean up
    }
  };

  if (reminder_type === "one-time") {
    // Schedule one-time reminder at dueDateTime
    const now = moment().tz("Asia/Kolkata");
    const reminderTime = moment.tz(
      reminderDateTime,
      "YYYY-MM-DD HH:mm",
      "Asia/Kolkata"
    );
    // const reminderTimeWithOffset = reminderTime.clone().subtract(20, "minutes");
    const delay = reminderTime.diff(now);

    if (delay <= 0) {
      console.log(
        `Task ${taskId} due date is in the past. Sending reminder now.`
      );
      await sendReminder();
      return res.status(200).json({ message: "One-time reminder sent" });
    }

    setTimeout(async () => {
      await sendReminder();
    }, delay);

    cronJobs.set(taskId, { type: "one-time" }); // Store for tracking
    console.log(
      `Scheduled one-time reminder for task ${taskId} at ${dueDateTime}`
    );
    return res.status(200).json({ message: "One-time reminder scheduled" });
  } else {
    // Handle recurring reminders (existing logic)
    const frequencyPattern =
      /(\d+)\s*(minute|min|mins|hour|hr|hrs|hours|day|days)s?/;
    const match = reminder_frequency?.match(frequencyPattern);

    if (!match) {
      console.log("Invalid reminder frequency format");
      return res
        .status(400)
        .json({ message: "Invalid reminder frequency format" });
    }

    const quantity = parseInt(match[1], 10);
    const unit = match[2];

    let cronExpression = "";
    if (unit === "minute" || unit === "min" || unit === "mins") {
      cronExpression = `*/${quantity} * * * *`;
    } else if (
      unit === "hour" ||
      unit === "hours" ||
      unit === "hrs" ||
      unit === "hr"
    ) {
      cronExpression = `0 */${quantity} * * *`;
    } else if (unit === "day" || unit === "days") {
      cronExpression = `0 0 */${quantity} * *`;
    } else {
      console.log("Unsupported frequency unit");
      return res.status(400).json({ message: "Unsupported frequency unit" });
    }

    const cronJob = cron.schedule(cronExpression, sendReminder);
    cronJobs.set(taskId, cronJob);
    console.log(
      `Scheduled recurring reminder for task ${taskId} with frequency ${reminder_frequency}`
    );
    return res.status(200).json({ message: "Recurring reminder scheduled" });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  makeTwilioRequest();
});

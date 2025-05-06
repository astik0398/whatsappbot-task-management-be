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
  const { data, error } = await supabase.from("tasks").select("*");
  if (error) throw error;
  return data;
}
async function main() {
  // currentTime = getFormattedTime()

  // console.log('currentTime', currentTime);

  allData = await getAllTasks();
  // console.log("allData==>", allData);
}
main();
app.get("/refresh", async (req, res) => {
  console.log("Refreshing tasks from Supabase...");
  const { data, error } = await supabase.from("tasks").select("*");
  if (error) {
    console.error("Error refreshing tasks:", error);
    return res.status(500).json({ message: "Error fetching tasks" });
  }
  allData = data;
  console.log("Tasks updated!");
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

  if (session.step === 5) {
    if (userMessage.toLowerCase() === "yes") {
      const task = session.task;
      const assignee = session.assignee;

      const { data, error } = await supabase
        .from("tasks")
        .update({ task_done: "Completed" })
        .eq("tasks", task)
        .eq("name", assignee)
        .select()
        .single();

      if (error) {
        console.error("Error updating task:", error);
        sendMessage(
          From,
          "Sorry, there was an error marking the task as completed."
        );
      } else {
        sendMessage(
          From,
          "Thank you! The task has been marked as completed! ✅"
        );
        sendMessage(assignerMap[0], `The task *${task}* was completed. ✅`);

        const taskId = data?.id;

        console.log("taskID after YES response", taskId);

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
    const reason = userMessage.trim();
    const task = session.task;
    const assignee = session.assignee;

    console.log("assignee----session====>", assignee);

    const { data, error } = await supabase
      .from("tasks")
      .update({ task_done: "Not Completed", reason: reason })
      .eq("tasks", task)
      .eq("name", assignee)
      .single();

    if (error) {
      console.error("Error updating task with reason:", error);
      sendMessage(From, "Sorry, there was an error saving the reason. ⚠️");
    } else {
      sendMessage(From, "📤 Your response has been sent to the assigner.");
      sendMessage(
        assignerMap[0],
        `⚠️ *Task Not Completed*

The task *${session.task}* was not completed.
📝 *Reason:* ${reason.trim()}`
      );
    }

    delete userSessions[From];
  } else {
    const prompt = `
You are a helpful task manager assistant. Respond with a formal tone and
a step-by-step format.
Your goal is to guide the user through task assignment:
- Ask for task details (task, assignee, due date, time and how often to send
reminder).
- Respond to yes/no inputs appropriately.
- Follow up if any information is incomplete.
- Keep the respone concise and structured.
- Once you have all the details please **summarize** the entered details

EXAMPLES: 

- If a user is asked about due date, due time and reminder frequncy, and user sends only due date and due time then it should again ask for reminder frequency and should not ignore that.
- Similarly if a user is asked about task, assignee and due date but user only only task and due date then it should again ask the user asking about the assignee since they did not sent that.

IMPORTANT:
- Once all details are collected, return **ONLY** with a JSON object
which will be used for backend purpose.
- Do **not** include any extra text before or after the JSON.
- This is only for backend procesing so do **NOT** send this JSON
format to user
- The JSON format should be:
{
"task": "<task_name>",
"assignee": "<assignee_name>",
"dueDate": "<YYYY-MM-DD>",
"dueTime": "<HH:mm>",
"reminder_frequency": "<reminder_frequency>"
}
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
          .from("tasks")
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
👤 *Assignee:* ${taskDetails.assignee}
📅 *Due Date:* ${taskDetails.dueDate}
⏰ *Due Time:* ${taskDetails.dueTime}
🔁 *Reminder Frequency:* ${taskDetails.reminder_frequency}`
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
              const { data, error } = await supabase
                .from("tasks")
                .update([
                  {
                    tasks: taskData.task,
                    reminder: true,
                    task_done: "Pending",
                    due_date: dueDateTime,
                    reminder_frequency: taskData.reminder_frequency,
                  },
                ])
                .ilike("name", taskData.assignee)
                .select();
              console.log("Matching Task:", data, error);
              if (error) {
                console.error("Error inserting task into Supabase:", error);
              } else {
                console.log("Task successfully added to Supabase.");
                sendMessage(
                  From,
                  `📌 *Task Assigned*

A new task, *${taskData.task}* has been assigned to *${taskData.assignee}*
🗓️ *Due Date:* ${dueDateTime}`
                );
                sendMessage(
                  `whatsapp:+${assignedPerson.phone}`,
                  `📬 *New Task Assigned!*

Hello *${taskData.assignee}*,
You've been assigned a new task:

📝 *Task:* *${taskData.task}*
📅 *Deadline:* ${dueDateTime}`
                );
                delete userSessions[From];
                session.conversationHistory = [];

                console.log("task-id-after inserting task", data[0].id);

                await fetch(
                  "https://whatsappbot-task-management-be-production.up.railway.app/update-reminder",
                  {
                    method: "POST",
                    headers: {
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify({
                      reminder_frequency: taskData.reminder_frequency,
                      taskId: data[0].id, // Pass the task ID
                    }),
                  }
                )
                  .then((res) => res.json())
                  .then((response) => {
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
              content: `You are a helpful assistant that schedules meetings using Google Calendar.

Your task is to first analyze the user's message and check if it contains all required information to schedule a meeting:
- Email of the invitee
- Title or topic of the meeting
- Date of the meeting
- Start time of the meeting (must include AM/PM unless it's clearly 24-hour format)
- Duration of the meeting

You MUST check for missing or ambiguous fields. Be especially strict about time ambiguity:
- If a time like "8" or "tomorrow 8" is mentioned without AM/PM, ask the user to clarify.
- Never assume AM or PM.
- Phrases like "8", "5", or "at 3" without a clear indication of AM/PM or 24-hour format should be considered ambiguous.
- If the year is missing in date of the meeting always assume the year as current year which is ${new Date().getFullYear()}

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
"I noticed you said 'tomorrow 8'. Did you mean 8 AM or 8 PM? Please reply with the exact time."

If the message is clear, contains all the required fields (invitee email, meeting title, date, time with AM/PM, and duration), and there is no ambiguity, proceed to schedule the meeting **immediately** without sending a confirmation or asking the user to respond again.

Do NOT reply with a summary or confirmation message if all the required fields are present and unambiguous. Simply schedule the meeting silently.
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
              },
              required: ["title", "date", "startTime", "durationMinutes"],
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
      const { title, date, startTime, durationMinutes, attendees = [] } = args;

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
      twiml.message(
        `✅ Meeting successfully created! 🎉\n📝 *Title:* ${title}\n📅 *Date:* ${startDateTime.format(
          "ddd MMM DD YYYY"
        )}\n🕒 *Time:* ${startDateTime.format("h:mm A")} IST\n🔗 *Link:* ${
          calendarResponse.data.hangoutLink
        }`
      );
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

    return res.send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
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
            background-color: #ff4d4d;
            color: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
            text-align: center;
            max-width: 400px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          ✅ Authentication successful! You can now schedule meetings on WhatsApp.
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("OAuth error:", err.message);
    res.send("❌ Failed to authenticate with Google.");
  }
});

let isCronRunning = false; // Track if the cron job is active
const cronJobs = new Map(); // Map to store cron jobs for each task

app.post("/update-reminder", async (req, res) => {
  const { reminder_frequency, taskId } = req.body;

  console.log("inside be update-reminder req.body", reminder_frequency, taskId);

  if (cronJobs.has(taskId)) {
    console.log(
      `Cron job already exists for task ${taskId}. Ignoring duplicate trigger.`
    );
    return res.status(200).json({ message: "Reminder already scheduled" });
  }

  isCronRunning = true;

  const frequencyPattern =
    /(\d+)\s*(minute|min|mins|hour|hr|hrs|hours|day|days)s?/;
  const match = reminder_frequency.match(frequencyPattern);

  console.log("frequencyPattern, match", frequencyPattern, match);

  if (!match) {
    console.log("Invalid reminder frequency format");
    return res
      .status(400)
      .json({ message: "Invalid reminder frequency format" });
  }

  const quantity = parseInt(match[1], 10); // Extract the numeric part
  const unit = match[2]; // Extract the unit (minute, hour, day)

  console.log("quantity, unit", quantity, unit);

  let cronExpression = "";

  // Construct the cron expression based on the unit
  if (unit === "minute" || unit === "min" || unit === "mins") {
    cronExpression = `*/${quantity} * * * *`; // Every X minutes
  } else if (
    unit === "hour" ||
    unit == "hours" ||
    unit === "hrs" ||
    unit === "hr"
  ) {
    cronExpression = `0 */${quantity} * * *`; // Every X hours, at the start of the hour
  } else if (unit === "day" || unit === "days") {
    cronExpression = `0 0 */${quantity} * *`; // Every X days, at midnight
  } else {
    console.log("Unsupported frequency unit");
    return res.status(400).json({ message: "Unsupported frequency unit" });
  }

  const cronJob = cron.schedule(cronExpression, async () => {
    console.log(`Checking reminder for task ${taskId}...`);

    const { data: tasks, error } = await supabase
      .from("tasks")
      .select("*")
      .eq("id", taskId)
      .eq("reminder", true)
      .neq("task_done", "Completed")
      .neq("task_done", "No")
      .neq("task_done", "Reminder sent")
      .not("tasks", "is", null)
      .neq("tasks", "")
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        console.log(
          `No matching task found for task ${taskId}. Stopping cron job.`
        );
        cronJobs.get(taskId)?.stop();
        cronJobs.delete(taskId);
      } else {
        console.error(`Error fetching task ${taskId}:`, error);
      }
      return;
    }

    console.log(`Found ${tasks} tasks to remind`);

    console.log("taskss inside cron", tasks);

    if (tasks) {
      console.log(`Sending reminder to: ${tasks.phone} for task ${taskId}`);
      sendMessage(
        `whatsapp:+${tasks.phone}`,
        `⏰ *Reminder*

Has the task *${tasks.tasks}* assigned to you been completed yet?
✉️ Reply with Yes or No.`
      );

      userSessions[`whatsapp:+${tasks.phone}`] = {
        step: 5,
        task: tasks.tasks,
        assignee: tasks.name,
      };
    } else {
      // Stop the cron job if the task no longer needs reminders
      console.log(`Stopping cron job for task ${taskId}`);
      cronJobs.get(taskId)?.stop();
      cronJobs.delete(taskId);
    }
  });

  cronJobs.set(taskId, cronJob);
  console.log(
    `Scheduled reminder for task ${taskId} with frequency ${reminder_frequency}`
  );

  res.status(200).json({ message: "Reminder scheduled" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  makeTwilioRequest();
});

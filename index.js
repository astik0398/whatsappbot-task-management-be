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
const path = require("path"); // NEW: Added path module import

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
  const shortURL = await tinyurl.shorten(longUrl); // Ensure you await the promise
  const code = shortURL.split("/").pop(); // Extract the part after the last "/"
  return code;
};

let allData = [];
let userSessions = {};
let assignerMap = [];
let todayDate = "";
let currentTime = "";

const sessions = {};

function truncateString(str) {
  if (typeof str !== 'string') {
    return str;
  }
  return str.length > 65 ? str.slice(0, 65) + '...' : str;
}

function formatDueDate(dueDateTime) {

    console.log('dueDateTime--->>',dueDateTime);

  const date = moment(dueDateTime, "DD-MM-YYYY HH:mm").toDate()

  const day = date.getDate();
  const monthIndex = date.getMonth();
  const year = date.getFullYear();

  const monthNames = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];

  // Function to get the ordinal suffix
  const getOrdinalSuffix = (n) => {
    if (n > 3 && n < 21) return n + "th";
    switch (n % 10) {
      case 1:
        return n + "st";
      case 2:
        return n + "nd";
      case 3:
        return n + "rd";
      default:
        return n + "th";
    }
  };

  const formattedDate = `${getOrdinalSuffix(day)} ${
    monthNames[monthIndex]
  } ${year}`;

  console.log('formattedDate--->>',formattedDate);
  
  return formattedDate;
}

const getFormattedDate = () => {
  const today = new Date();
  const options = { year: "numeric", month: "long", day: "numeric" };

  // console.log(today.toLocaleDateString("en-US", options));

  return today.toLocaleDateString("en-US", options);
};

function extractTime(datetimeStr) {
  // Assumes format "YYYY-MM-DD HH:MM"
  const parts = datetimeStr.split(" ");
  if (parts.length === 2) {
    return parts[1]; // returns "20:00"
  }
  return null; // return null if format is invalid
}

function extractDate(datetimeStr) {
  // Assumes format "YYYY-MM-DD HH:MM"
  const parts = datetimeStr.split(" ");
  if (parts.length === 2) {
    return parts[0]; // returns "2025-07-27"
  }
  return null; // return null if format is invalid
}

const getCurrentDate = () => {
  const now = moment().tz("Asia/Kolkata"); // Explicitly set to Asia/Kolkata
  const year = now.get("year");
  const month = String(now.get("month") + 1).padStart(2, "0");
  const day = String(now.get("date")).padStart(2, "0");
  const hours = String(now.get("hour")).padStart(2, "0");
  const minutes = String(now.get("minute")).padStart(2, "0");

  // console.log(`${year}-${month}-${day} ${hours}:${minutes}`);
  return `${day}-${month}-${year} ${hours}:${minutes}`;
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
  const session = userSessions[From];
  const conversationHistory = session.conversationHistory || [];
  conversationHistory.push({ role: "user", content: userMessage });

  assignerMap.push(From);

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

        const job = cronJobs.get(taskId);
        if (job?.timeoutId) {
          clearTimeout(job.timeoutId);
        }
        if (job?.cron) {
          job.cron.stop();
        }
        cronJobs.delete(taskId);

        await supabase.from("reminders").delete().eq("taskId", taskId);
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
        null, // No body for template
        true, // isTemplate flag
        {
          1: `*${session.task}*`,
          2: `*${session.assignee}*`,
          3: `*${reason.trim()}*`,
          4: session.taskId,
        },
        process.env.TWILIO_NOT_COMPLETED_REASON
      );
    }

    delete userSessions[From];
  } else if (session.step === 8) {
    console.log(
      "<--------------------im inside this step which is 8-------------->"
    );

    const { taskId, number } = userSessions[From];

    console.log(
      "<--------------------im inside this step which is 8 after console logging taskId-------------->",
      taskId
    );

    // Validate input format: YYYY-MM-DD HH:MM
    const deadlineInput = userMessage.trim();
const isValidFormat = /^\d{2}-\d{2}-\d{4} \d{1,2}:\d{2}$/.test(deadlineInput);

    if (!isValidFormat) {
      await sendMessage(
        From,
        "❌ Invalid format. Please send the date and time like this:\n*2025-07-23 14:47*"
      );
      return;
    }

        // ⏱ Normalize to HH:mm format
const [datePart, timePart] = deadlineInput.split(" ");
let [hour, minute] = timePart.split(":");

if (hour.length === 1) hour = "0" + hour;

const normalizedDeadline = `${datePart} ${hour}:${minute}`;

    // Proceed to update the deadline
    const { data: groupedData, error: fetchError } = await supabase
      .from("grouped_tasks")
      .select("id, tasks, name, employerNumber");

    if (fetchError) {
      console.error("❌ Error fetching tasks:", fetchError);
      await sendMessage(From, "Error: Could not retrieve task data.");
      return;
    }

    const matchedRow = groupedData.find((row) =>
      row.tasks?.some((task) => task.taskId === taskId)
    );

    if (!matchedRow) {
      await sendMessage(From, "❌ Task not found.");
      return;
    }

    const updatedTasks = matchedRow.tasks.map((task) =>
      task.taskId === taskId
        ? { ...task, due_date: normalizedDeadline, task_done: "Pending" }
        : task
    );

    const { error: updateError } = await supabase
      .from("grouped_tasks")
      .update({ tasks: updatedTasks })
      .eq("id", matchedRow.id);

    if (updateError) {
      console.error("❌ Error updating deadline:", updateError);
      await sendMessage(
        From,
        "❌ Failed to update deadline. Please try again."
      );
      return;
    }

    // ✅ Success
    await sendMessage(
      From,
      `✅ Deadline for the task has been updated to *${normalizedDeadline}*`
    );

    // Optionally notify the assignee as well here
    const updatedTask = updatedTasks.find((task) => task.taskId === taskId);
    const assigneePhone = session.number;

    console.log(
      "updated task & assignee phone, userSessions, groupedData----->🔋🔋🔋",
      updatedTask,
      matchedRow
    );

    const { data: newgroupedData, error: newfetchError } = await supabase
      .from("grouped_tasks")
      .select("id, tasks, name, employerNumber");

    const updatedmatchedRow = newgroupedData.find((row) =>
      row.tasks?.some((task) => task.taskId === taskId)
    );

    const newtaskList = updatedmatchedRow.tasks.filter(
      (task) =>
        task.task_done === "Pending" || task.task_done == "Not Completed"
    ); // Only show pending tasks

    console.log(
      "inside handleUserInput taskList lengthh---->>>>",
      newtaskList,
      newtaskList.length
    );

    const newTemplateMsg = {
      1: updatedTask.task_details,
      2: normalizedDeadline,
    };

    newtaskList.forEach((task, index) => {
      console.log("inside for each =======>>>>>", task);

      newTemplateMsg[`${index + 4}`] = `${formatDueDate(
        task.due_date
      )}`;
      newTemplateMsg[`${index + 4}_description`] = `${truncateString(task.task_details)}`;
      newTemplateMsg[`task_${index}`] = task.taskId;
    });

    try {
      if (newtaskList.length === 1) {
        console.log("inside task length which is 1");

        await sendMessage(
          `whatsapp:+${assigneePhone}`,
          null, // No body for template
          true, // isTemplate flag
          newTemplateMsg,
          "HXfb875309b15d7128367c4f9305dd8276" // Content SID for the List Picker template
        );
        console.log("List Picker message sent successfully");
      } else if (newtaskList.length === 2) {
        console.log("inside task length which is 2");

        await sendMessage(
          `whatsapp:+${assigneePhone}`,
          null, // No body for template
          true, // isTemplate flag
          newTemplateMsg,
          "HXda825067d4d47841fe98200057513274" // Content SID for the List Picker template
        );
        console.log("List Picker message sent successfully");
      } else if (newtaskList.length === 3) {
        console.log("inside task length which is 3");

        await sendMessage(
          `whatsapp:+${assigneePhone}`,
          null, // No body for template
          true, // isTemplate flag
          newTemplateMsg,
          "HX78a953c4dbc3f4a9bcdc44a6448aec5c" // Content SID for the List Picker template
        );
        console.log("List Picker message sent successfully");
      } else if (newtaskList.length === 4) {
        console.log("inside task length which is 3");

        await sendMessage(
          `whatsapp:+${assigneePhone}`,
          null, // No body for template
          true, // isTemplate flag
          newTemplateMsg,
          "HXa041d39221c30a3c4575feb18305cb8f" // Content SID for the List Picker template
        );
        console.log("List Picker message sent successfully");
      } else if (newtaskList.length === 5) {
        console.log("inside task length which is 3");

        await sendMessage(
          `whatsapp:+${assigneePhone}`,
          null, // No body for template
          true, // isTemplate flag
          newTemplateMsg,
          "HXcd39864c9c08cb1788610d4d64928204" // Content SID for the List Picker template
        );
        console.log("List Picker message sent successfully");
      } else if (newtaskList.length === 6) {
        console.log("inside task length which is 3");

        await sendMessage(
          `whatsapp:+${assigneePhone}`,
          null, // No body for template
          true, // isTemplate flag
          newTemplateMsg,
          "HXb24805d076347b18194b2021e7a5763a" // Content SID for the List Picker template
        );
        console.log("List Picker message sent successfully");
      } else if (newtaskList.length === 7) {
        console.log("inside task length which is 3");

        await sendMessage(
          `whatsapp:+${assigneePhone}`,
          null, // No body for template
          true, // isTemplate flag
          newTemplateMsg,
          "HX1e09b5dc9fc07659b24b2447b964dc1b" // Content SID for the List Picker template
        );
        console.log("List Picker message sent successfully");
      } else if (newtaskList.length === 8) {
        console.log("inside task length which is 3");

        await sendMessage(
          `whatsapp:+${assigneePhone}`,
          null, // No body for template
          true, // isTemplate flag
          newTemplateMsg,
          "HXb0dc5526de6b3120881186e224b958f7" // Content SID for the List Picker template
        );
        console.log("List Picker message sent successfully");
      } else if (newtaskList.length === 9) {
        console.log("inside task length which is 3");

        await sendMessage(
          `whatsapp:+${assigneePhone}`,
          null, // No body for template
          true, // isTemplate flag
          newTemplateMsg,
          "HX0219abbc921e8400cebbe8d0e1dd0fff" // Content SID for the List Picker template
        );
        console.log("List Picker message sent successfully");
      } else if (newtaskList.length >= 10) {
        console.log("inside task length which is 3");

        await sendMessage(
          `whatsapp:+${assigneePhone}`,
          null, // No body for template
          true, // isTemplate flag
          newTemplateMsg,
          "HXf6a77af216feafb39e2fe4f2dfe8fc10" // Content SID for the List Picker template
        );
        console.log("List Picker message sent successfully");
      }
    } catch (sendError) {
      console.error("Error sending List Picker message:", sendError);
      await sendMessage(
        From,
        "⚠️ Error displaying task list. Please try again."
      );
      return;
    }

    // NEW: Reschedule the reminder using the /update-reminder endpoint
    try {
      // Clear any existing reminder for this task
      const existingJob = cronJobs.get(taskId);
      if (existingJob?.timeoutId) {
        clearTimeout(existingJob.timeoutId);
        console.log(`Cleared existing timeout for task ${taskId}`);
      }
      if (existingJob?.cron) {
        existingJob.cron.stop();
        console.log(`Stopped existing cron job for task ${taskId}`);
      }
      cronJobs.delete(taskId);

      // Delete existing reminder from Supabase
      await supabase.from("reminders").delete().eq("taskId", taskId);

      // Prepare data for the /update-reminder endpoint
      const reminderData = {
        reminder_type: updatedTask.reminder_type || "recurring", // Default to recurring if not specified
        reminder_frequency: updatedTask.reminder_frequency || null,
        taskId: taskId,
        dueDateTime: normalizedDeadline, // Updated due date and time
        reminderDateTime: updatedTask.reminderDateTime || null, // Use existing reminderDateTime for one-time reminders
      };

      // Call the /update-reminder endpoint
      const response = await fetch("https://whatsappbot-task-management-be-production.up.railway.app/update-reminder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(reminderData),
      });

      const result = await response.json();
      console.log(`Reminder rescheduled for task ${taskId}:`, result);

      // Update user session to reflect that the task is back in a reminder state
      userSessions[From] = {
        ...userSessions[From],
        step: 0, // Reset step to allow further interactions
      };
    } catch (error) {
      console.error("Error rescheduling reminder:", error);
      await sendMessage(
        From,
        "⚠️ Failed to reschedule reminder. Please try again."
      );
    }

    // Clean up session
    delete userSessions[From];

    return;
  } else {
    const prompt = `You are a helpful task manager assistant. Respond with a formal tone and a step-by-step format. Your goal is to guide the user through task assignment by collecting all required details: task description, assignee, due date, due time, and reminder preference. Do not assign the task until all details are provided and unambiguous.

**Task Assignment Rules**:
- Required details: task description, assignee, due date (DD-MM-YYYY), due time (HH:mm), and reminder preference.
- Reminder preference can be:
  - Recurring (e.g., "every 3 mins", "every 2 hours", "every 1 day").
  - One-time (e.g., "one-time on 20th May at 5PM").
- If a user provides a reminder like "every 8 mins" or "every 2 hrs", treat it as recurring.
- For one-time reminders, explicitly ask for the reminder date and time (e.g., "Please specify the date and time for the one-time reminder, e.g., '20th May at 5PM'.").
- For recurring reminders, ensure a valid frequency is provided (e.g., "every 5 mins"). If only "recurring" is specified, prompt for the frequency (e.g., "Please specify the frequency for the recurring reminder, e.g., 'every 5 mins'.").
- Respond to yes/no inputs appropriately.
- If any detail is missing or ambiguous, prompt the user with a bulleted list (using "•") specifying only the missing details.
- Do not proceed with task assignment if any required detail is missing, and do not assume or assign 'null' for missing fields.
- If all required details are provided in a single message and are unambiguous, assign the task immediately without asking for confirmation or sending a summary.

**Task Description Correction**:
- Automatically detect and correct typos, spelling errors, or grammatical issues in the task description.
- Use natural language understanding to infer the intended meaning and correct to standard English.
- Ensure the corrected task is a complete, professional, and grammatically correct sentence.
- Example: If the user provides "snd remnder everydy for aprovl", correct it to "Send reminder every day for approval".

**Assignee Detection**:
- Interpret the assignee from phrases like "tell [name] to [task]", "ask [name] to [task]", or explicit mentions like "assignee is [name]".
- The assignee must be a proper name (e.g., "Astik", "John Doe", "Anandini").
- Do not assume non-name terms (e.g., "this", "assigning") as the assignee.
- If the assignee is missing or ambiguous, prompt: "Please specify the assignee for the task."

**Due Date Handling**:
- If the user provides a day and month (e.g., "28th Feb" or "28 February"), assume the current year (2025) and format as "DD-MM-YYYY" (e.g., "28-02-2025").
- If the user provides a full date (e.g., "28th Feb 2025"), return it as is in "DD-MM-YYYY" format.
- For dynamic terms:
  - Current date is ${todayDate}
  - "today": Use the current date which is ${todayDate} (e.g., if today is April 5, 2025, it should return "05-04-2025").
  - "tomorrow": Use the next day’s date (e.g., "31-07-2025") (e.g., if today is April 5, 2025, "tomorrow" should be "06-04-2025").
  - "next week": Use the same day in the following week (e.g., if today is April 5, 2025, "next week" would be April 12, 2025).
  - "in X days": Calculate the date accordingly (e.g., "in 3 days" from 30-07-2025 is "02-08-2025").
  - "next month": Use the same day in the next month (e.g., if today is April 5, 2025, "next month" should become "05-05-2025").
  - "tonight Xpm" or "tonight at Xpm": Treat as today's date (${todayDate}) and the specified time (e.g., "tonight at 8pm" is "30-07-2025 20:00").
  - If "tonight" is provided without a time, prompt for the time.

**Due Time Handling**:
- Current time is ${currentTime}.
- Convert AM/PM times to 24-hour format (e.g., "6 PM" to "18:00", "6 AM" to "06:00").
- For "next X hours" or "in X minutes", calculate from the current time (e.g., if current time is 14:42, "next 5 hours" is "19:42").
- Always output time in "HH:mm" format.
- If due time is missing, prompt: "Please specify the due time for the task."

**Reminder Handling**:
- For recurring reminders:
  - Set 'reminder_type' to "recurring".
  - Set 'reminder_frequency' to the user-specified frequency (e.g., "every 5 mins").
  - Set 'reminderDateTime' to null.
  - If only "recurring" is provided, prompt for the frequency.
- For one-time reminders:
  - Set 'reminder_type' to "one-time".
  - Set 'reminder_frequency' to null.
  - Set 'reminderDateTime' to the user-specified date and time in "DD-MM-YYYY HH:mm" format.
  - If the reminder date or time is missing (e.g., user only says "one-time" or provides an incomplete date/time), prompt: "Please specify the date and time for the one-time reminder, e.g., '20th May at 5PM'."
  - Do not proceed with task assignment if the reminder date and time are not fully specified for one-time reminders.
  - If the reminder date/time is missing, prompt for it.
- Do not assume the reminder time is tied to the due date for one-time reminders unless explicitly stated by the user.

**Conversation History**:
- Conversation history: ${JSON.stringify(conversationHistory)}
- User input: ${userMessage}
- Combine the current user input with the conversation history to extract all required task details.
- Treat multiple messages as part of a single conversation thread.
- Check the full conversation history for missing details before prompting the user.
- Do not ask for a detail if it is already clearly provided in earlier messages.

**Task Assignment**:
- Once all required details (task, assignee, due date, due time, reminder type, and reminder frequency or date/time) are collected, return **only** a JSON object for backend processing.
- Do not include any extra text before or after the JSON.
- Do not send a summary or ask for confirmation before returning the JSON.
- The JSON format must be:
{
  "task": "<task_name>",
  "assignee": "<assignee_name>",
  "dueDate": "<DD-MM-YYYY>",
  "dueTime": "<HH:mm>",
  "reminder_type": "<recurring|one-time>",
  "reminder_frequency": "<reminder_frequency or null for one-time>",
  "reminderDateTime": "<DD-MM-YYYY HH:mm or null for recurring>"
}
- Do not assign the task or return the JSON if any required detail is missing.`;

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
                started_at: session.started_at || getCurrentDate(),
                reminder_type: taskData.reminder_type || "recurring", // Default to recurring if not specified
                reminderDateTime: taskData.reminderDateTime || null, // Store reminder date and time
                notes: session.notes || null, // Include notes from session
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

              // console.log("Matching Task:", data, error);
              if (error) {
                console.error("Error inserting task into Supabase:", error);
                sendMessage(From, "Error saving the task.");
              } else {
                console.log("Task successfully added to Supabase.");

                const taskList = data[0].tasks
                  .filter(
                    (task) =>
                      task.task_done === "Pending" ||
                      task.task_done == "Not Completed"
                  ) // Only show pending tasks
                  .slice(0, 10); // Twilio list picker supports up to 10 items

                console.log(
                  "inside handleUserInput taskList lengthh---->>>>",
                  taskList.length
                );

                const templateData = {
                  1: taskData.task, // Task name for the assignment message
                  2: taskData.assignee.toUpperCase(), // Assignee name
                  3: dueDateTime, // Due date and time
                };

                taskList.forEach((task, index) => {
                  console.log("inside for each =======>>>>>", task);

                  templateData[`${index + 4}`] = `${formatDueDate(
                    task.due_date
                  )}`;
                  templateData[
                    `${index + 4}_description`
                  ] = `${truncateString(task.task_details)}`;
                  templateData[`task_${index}`] = task.taskId;
                });
                console.log(
                  "inside handleUserInput taskList---->>>>",
                  taskList
                );
                console.log("templateData:::::::::::::", templateData);

                try {
                  if (taskList.length === 1) {
                    console.log("inside task length which is 1");

                    await sendMessage(
                      From,
                      null, // No body for template
                      true, // isTemplate flag
                      templateData,
                      "HX143dece1a4b71701e48172ecf1028544" // Content SID for the List Picker template
                    );
                    console.log("List Picker message sent successfully");
                  } else if (taskList.length === 2) {
                    console.log("inside task length which is 2");

                    await sendMessage(
                      From,
                      null, // No body for template
                      true, // isTemplate flag
                      templateData,
                      "HX49a52e852db353767236c0d861b424cb" // Content SID for the List Picker template
                    );
                    console.log("List Picker message sent successfully");
                  } else if (taskList.length === 3) {
                    console.log("inside task length which is 3");

                    await sendMessage(
                      From,
                      null, // No body for template
                      true, // isTemplate flag
                      templateData,
                      "HXebe78675adff94bec5ec589fa152a0bf" // Content SID for the List Picker template
                    );
                    console.log("List Picker message sent successfully");
                  } else if (taskList.length === 4) {
                    console.log("inside task length which is 4");
                    await sendMessage(
                      From,
                      null, // No body for template
                      true, // isTemplate flag
                      templateData,
                      "HXb62868d80285ddf8dbb3331ee500c779" // Content SID for the List Picker template
                    );
                    console.log("List Picker message sent successfully");
                  } else if (taskList.length === 5) {
                    console.log("inside task length which is 5");
                    await sendMessage(
                      From,
                      null, // No body for template
                      true, // isTemplate flag
                      templateData,
                      "HXbddd566270726c60dd8eab03e810691e" // Content SID for the List Picker template
                    );
                    console.log("List Picker message sent successfully");
                  } else if (taskList.length === 6) {
                    console.log("inside task length which is 6");
                    await sendMessage(
                      From,
                      null, // No body for template
                      true, // isTemplate flag
                      templateData,
                      "HX92f432ace1ce5ea5831c9724f43fe2f9" // Content SID for the List Picker template
                    );
                    console.log("List Picker message sent successfully");
                  } else if (taskList.length === 7) {
                    console.log("inside task length which is 7");
                    await sendMessage(
                      From,
                      null, // No body for template
                      true, // isTemplate flag
                      templateData,
                      "HX728e5be86b84bc559ba24a48e96b7451" // Content SID for the List Picker template
                    );
                    console.log("List Picker message sent successfully");
                  } else if (taskList.length === 8) {
                    console.log("inside task length which is 8");
                    await sendMessage(
                      From,
                      null, // No body for template
                      true, // isTemplate flag
                      templateData,
                      "HX22bfc9a9f4bd64345e8673ba3bede61b" // Content SID for the List Picker template
                    );
                    console.log("List Picker message sent successfully");
                  } else if (taskList.length === 9) {
                    console.log("inside task length which is 9");
                    await sendMessage(
                      From,
                      null, // No body for template
                      true, // isTemplate flag
                      templateData,
                      "HX3805195cb6e0e7e5b0ef7d67235700cb" // Content SID for the List Picker template
                    );
                    console.log("List Picker message sent successfully");
                  } else if (taskList.length >= 10) {
                    console.log("inside task length which is 10");
                    await sendMessage(
                      From,
                      null, // No body for template
                      true, // isTemplate flag
                      templateData,
                      "HX0b055274ff5b8a0a93e5509997837daf" // Content SID for the List Picker template
                    );
                    console.log("List Picker message sent successfully");
                  }
                } catch (sendError) {
                  console.error(
                    "Error sending List Picker message:",
                    sendError
                  );
                  await sendMessage(
                    From,
                    "⚠️ Error displaying task list. Please try again."
                  );
                  return;
                }

                sendMessage(
                  `whatsapp:+${assignedPerson.phone}`,
                  null, // No body for template
                  true, // isTemplate flag
                  {
                    1: `*${taskData.assignee.toUpperCase()}*`,
                    2: `*${taskData.task}*`,
                    3: `${dueDateTime}`,
                    4: From,
                    5: `${taskData.assignee.toUpperCase()}`,
                  },
                  process.env.TWILIO_SHOW_ALL_TASKS
                );

                console.log(
                  "ASSINED PERSON PHONE-->📝📝",
                  assignedPerson.phone,
                  "FROM-->📝📝",
                  From,
                  "ASSIGNEE NAME-->📝📝",
                  taskData.assignee.toUpperCase()
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

async function sendMessage(
  to,
  message,
  isTemplate = false,
  templateData = {},
  template_id
) {
  console.log("Sending message to:", to);
  console.log("Message:", message);

  console.log("isTemplate-->", isTemplate, "templateData-->", templateData);

  try {
    const messageOptions = {
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    };

    if (isTemplate) {
      messageOptions.contentSid = template_id; // Template SID from .env
      messageOptions.contentVariables = JSON.stringify(templateData);
    } else {
      messageOptions.body = message;
    }

    const sentMessage = await client.messages.create(messageOptions);
    console.log("Message sent successfully:", sentMessage.sid);
    return sentMessage;
  } catch (err) {
    console.error("Error sending message:", err);
    if (err.code) {
      console.error("Twilio error code:", err.code);
    }
    throw err;
  }
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

// TEXT EXTRACTION FROM THE IMAGE (BAKERY RECEIPT CODE) "STARTS HERE"

async function downloadImage(url, filePath) {
  try {
    const response = await axios({
      url,
      method: "GET",
      responseType: "stream",
      auth: {
        username: process.env.TWILIO_ACCOUNT_SID,
        password: process.env.TWILIO_AUTH_TOKEN,
      },
    });
    response.data.pipe(fs.createWriteStream(filePath));
    return new Promise((resolve, reject) => {
      response.data.on("end", () => resolve(true));
      response.data.on("error", (err) => reject(err));
    });
  } catch (error) {
    console.error("Error downloading image:", error);
    return false;
  }
}

async function uploadToSupabase(filePath, fileName) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    const { data, error } = await supabase.storage
      .from("images")
      .upload(`uploads/${fileName}`, fileBuffer, {
        contentType: `image/${fileName.split(".").pop()}`,
        upsert: false,
      });
    if (error) {
      console.error("Supabase upload error:", error);
      return null;
    }
    const { data: publicUrlData } = supabase.storage
      .from("images")
      .getPublicUrl(`uploads/${fileName}`);
    console.log("Supabase public URL:", publicUrlData.publicUrl);
    return publicUrlData.publicUrl;
  } catch (error) {
    console.error("Error uploading to Supabase:", error);
    return null;
  }
}

async function extractTextFromImage(
  imageUrl,
  maxRetries = 3,
  retryDelay = 1000
) {
  console.log("inside extractTextFromImage func");
  let attempts = 0;

  while (attempts < maxRetries) {
    try {
      const response = await axios.post(
        "https://app.wordware.ai/api/released-app/dedd9680-4a3b-4eb2-a3bc-fface48c4322/run",
        {
          inputs: {
            new_input_1: {
              type: "image",
              image_url: imageUrl,
            },
          },
          version: "^2.11",
        },
        {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.WORDWARE_API_KEY_EXTRACT}`,
          },
        }
      );
      const newGen = await extractNewGeneration(response.data);
      if (newGen) {
        return newGen; // Success, return the extracted text
      } else {
        attempts++;
        console.log(
          `Attempt ${attempts} failed, extractedText is null. Retrying...`
        );
        if (attempts < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, retryDelay)); // Wait before retrying
        }
      }
    } catch (error) {
      console.error(
        `Error extracting text from image (Attempt ${attempts + 1}):`,
        error.message
      );
      if (error.response) {
        console.error(
          "Wordware error details:",
          JSON.stringify(error.response.data, null, 2)
        );
      }
      attempts++;
      if (attempts < maxRetries) {
        console.log(`Retrying after error... Attempt ${attempts + 1}`);
        await new Promise((resolve) => setTimeout(resolve, retryDelay)); // Wait before retrying
      }
    }
  }

  console.error(`Failed to extract text after ${maxRetries} attempts.`);
  return null; // Return null if all retries fail
}

function extractNewGeneration(rawResponse) {
  console.log("inside extracted new gen...");
  const lines = rawResponse.trim().split("\n");
  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      if (
        json.type === "chunk" &&
        json.value &&
        json.value.output &&
        json.value.output.new_generation
      ) {
        console.log(
          "json.value.output.new_generation;",
          json.value.output.new_generation
        );
        return json.value.output.new_generation;
      }
    } catch (err) {
      continue;
    }
  }
  return null;
}

async function insertBakeryOrder(data, From) {
  console.log("data inside supabase insert function---> 1", data);
  if (From === "whatsapp:+918013356481") {
    data.userId = "253d8af9-aa41-4249-8d8e-e85acd464650";
    data.employerNumber = "whatsapp:+918013356481";
  } else if (From === "whatsapp:+14155839275") {
    data.userId = "c20d5529-7afc-400a-83fb-84989f5a03ee";
    data.employerNumber = "whatsapp:+14155839275";
  } else if (From === "whatsapp:+917980018498") {
    data.userId = "ec579488-8a1c-4a72-8e0d-8fc68c4622b6";
    data.employerNumber = "whatsapp:+917980018498";
  }
  console.log("data inside supabase insert function---> 2", data);

  try {
    // Step 1: Check for existing record
    const { data: existingUser, error: fetchError } = await supabase
      .from("grouped_tasks")
      .select("id, tasks")
      .eq("phone", data.phone)
      .eq("employerNumber", From)
      .maybeSingle();

    if (fetchError) {
      console.error("Error checking existing phone:", fetchError);
      return false;
    }

    if (!existingUser) {
      console.log("No existing user with phone:", data.phone);
      return false;
    }

    // Validation successful; do not insert tasks yet
    return true;
  } catch (err) {
    console.error("Unexpected error validating bakery order:", err);
    return false;
  }
}
// TEXT EXTRACTION FROM THE IMAGE (BAKERY RECEIPT CODE) "ENDS HERE"

async function makeTwilioRequest() {
  app.post("/whatsapp", async (req, res) => {
    const buttonPayload = req.body.ButtonPayload;

    console.log("buttonPayload inside whatsapp endpoint---->", buttonPayload);

    const { Body, From } = req.body;

    todayDate = getFormattedDate();
    currentTime = getFormattedTime();

    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0;
    const numMedia = parseInt(req.body.NumMedia || "0");

    let userMessage = Body.trim();

    console.log(
      "List picker Payload inside whatsapp endpoint==============---->>>>>>>>>>>>>>>>",
      req.body.ListId
    );

    if (req.body.ListId && req.body.ListId.startsWith("managetask_")) {
      // This block will run when ListId starts with "managetask_"
      const actualId = req.body.ListId.replace("managetask_", "");
      const { data: groupedData, error } = await supabase
        .from("grouped_tasks")
        .select("name, phone, tasks, employerNumber");

      const matchedRow = groupedData.find((row) =>
        row.tasks?.some((task) => task.taskId === actualId)
      );

      // Get the specific task
      const matchedTask = matchedRow.tasks.find(
        (task) => task.taskId === actualId
      );

      sendMessage(
        From,
        null, // No body for template
        true, // isTemplate flag
        {
          1: `*${matchedTask.task_details}*`,
          2: extractDate(matchedTask.due_date),
          3: extractTime(matchedTask.due_date),
          4: matchedTask.taskId,
        },
        process.env.TWILIO_MANAGE_TASKS_FOLLOW_UP
      );

      return;
    }

    if (req.body.ListId) {
      let actualId;

      if (req.body.ListId.startsWith("delete_")) {
        actualId = req.body.ListId.replace("delete_", "");
      } else {
        actualId = req.body.ListId;
      }

      const { data: groupedData, error } = await supabase
        .from("grouped_tasks")
        .select("name, phone, tasks, employerNumber");

      const matchedRow = groupedData.find((row) =>
        row.tasks?.some((task) => task.taskId === actualId)
      );

      // Get the specific task
      const matchedTask = matchedRow.tasks.find(
        (task) => task.taskId === actualId
      );

      console.log(
        "inside actualIdddd showing matchedTask============>>>>>>>>>>>>>",
        matchedTask
      );

      sendMessage(
        From,
        null, // No body for template
        true, // isTemplate flag
        {
          1: `*${matchedTask.task_details}*`,
          2: matchedTask.due_date,
          3: matchedTask.taskId,
        },
        process.env.TWILIO_LIST_PICKER_FOLLOW_UP
      );

      console.log("task delete message sent 📌📌");

      return;
    }

    let incomingMsg = Body.trim();

    const userNumber = req.body.From;

    console.log("📝📝📝📝📝📝📝📝📝📝", typeof buttonPayload);

    if (
      typeof buttonPayload === "string" &&
      buttonPayload.startsWith("show_all_tasks")
    ) {
      const [, assignorNumber, assigneenName] = buttonPayload.split(" ");

      console.log("im inside show all tasks button 📝📝📝📝📝");

      const { data, error } = await supabase
        .from("grouped_tasks")
        .select("tasks")
        .eq("name", assigneenName)
        .eq("employerNumber", assignorNumber);

      if (error) {
        console.error("Error fetching tasks 📝📝📝📝📝;;;:", error);
        sendMessage(From, "Sorry, there was an error accessing the task.");
        return;
      }

      console.log("im inside show all tasks button 📝📝", data);

      const showAllTaskList = data[0].tasks.filter(
        (task) =>
          task.task_done === "Pending" || task.task_done == "Not Completed"
      );

      console.log(
        "showAllTaskList====>",
        showAllTaskList,
        showAllTaskList.length
      );

      const showTaskTemplateData = {};

      showAllTaskList.forEach((task, index) => {
        showTaskTemplateData[`${index + 4}`] = `${formatDueDate(
          task.due_date
        )}`;
        showTaskTemplateData[
          `${index + 4}_description`
        ] = `${truncateString(task.task_details)}`;
        showTaskTemplateData[`task_${index}`] = task.taskId;
      });

      if (showAllTaskList.length === 1) {
        console.log("inside length 1 📌 📌 📌 ");
        await sendMessage(
          From,
          null, // No body for template
          true, // isTemplate flag
          showTaskTemplateData,
          "HX7b6478a3bb49180dc8bbb4bf699e207c" // Content SID for the List Picker template
        );
        return;
      } else if (showAllTaskList.length === 2) {
        console.log("inside length 2 📌 📌 📌 ");
        await sendMessage(
          From,
          null, // No body for template
          true, // isTemplate flag
          showTaskTemplateData,
          "HX02c22a676540dc3839fc5c97895c664f" // Content SID for the List Picker template
        );
        return;
      } else if (showAllTaskList.length === 3) {
        console.log("inside length 3 📌 📌 📌 ");
        await sendMessage(
          From,
          null, // No body for template
          true, // isTemplate flag
          showTaskTemplateData,
          "HXd2f4de4a63ed86aefe154ab7ed4a76c8" // Content SID for the List Picker template
        );
        return;
      } else if (showAllTaskList.length === 4) {
        console.log("inside length 4 📌 📌 📌 ");
        await sendMessage(
          From,
          null, // No body for template
          true, // isTemplate flag
          showTaskTemplateData,
          "HX8fff4a9828c852f60d2472470549a20e" // Content SID for the List Picker template
        );
        return;
      } else if (showAllTaskList.length === 5) {
        console.log("inside length 5 📌 📌 📌 ");
        await sendMessage(
          From,
          null, // No body for template
          true, // isTemplate flag
          showTaskTemplateData,
          "HXe17549acb47e4a2aeb71170a41006578" // Content SID for the List Picker template
        );
        return;
      } else if (showAllTaskList.length === 6) {
        console.log("inside length 6 📌 📌 📌 ");
        await sendMessage(
          From,
          null, // No body for template
          true, // isTemplate flag
          showTaskTemplateData,
          "HX34995e2a16c6a4399877204f816c63f3" // Content SID for the List Picker template
        );
        return;
      } else if (showAllTaskList.length === 7) {
        console.log("inside length 7 📌 📌 📌 ");
        await sendMessage(
          From,
          null, // No body for template
          true, // isTemplate flag
          showTaskTemplateData,
          "HXef57c0507cbc89f2c038e4e156cd1051" // Content SID for the List Picker template
        );
        return;
      } else if (showAllTaskList.length === 8) {
        console.log("inside length 8 📌 📌 📌 ");
        await sendMessage(
          From,
          null, // No body for template
          true, // isTemplate flag
          showTaskTemplateData,
          "HXdcb9f86bb6cd171e899fc5af60d14ecf" // Content SID for the List Picker template
        );
        return;
      } else if (showAllTaskList.length === 9) {
        console.log("inside length 9 📌 📌 📌 ");
        await sendMessage(
          From,
          null, // No body for template
          true, // isTemplate flag
          showTaskTemplateData,
          "HX67970494a9f265a70722802990ce3eaa" // Content SID for the List Picker template
        );
        return;
      } else if (showAllTaskList.length >= 10) {
        console.log("inside length 10 📌 📌 📌 ");
        await sendMessage(
          From,
          null, // No body for template
          true, // isTemplate flag
          showTaskTemplateData,
          "HX1085de0e0c8e158aa798e6711cf2282e" // Content SID for the List Picker template
        );
        return;
      }
    } else if (buttonPayload) {
      console.log("ButtonPayload received:", buttonPayload);

      // Parse ButtonPayload (format: yes_<taskId> or no_<taskId>)
      const [response, taskId] = buttonPayload.split("_");

      const { data: allGroupedData, newError } = await supabase
        .from("grouped_tasks")
        .select("name, phone, tasks, employerNumber");

      const allMatchedRow = allGroupedData.find((row) =>
        row.tasks?.some((task) => task.taskId === taskId)
      );

      console.log("response to buttons ======>🕯🕯🕯🕯🕯🕯🕯", response, taskId);

      if (response === "updatedeadline") {
        console.log(
          "im inside this line taskId, sessions, allMatchedRow----> 🔋🔋🔋🔋🔋🔋🔋🔋🔋🔋🔋🔋🔋🔋🔋",
          taskId,
          sessions,
          allMatchedRow
        );

       sendMessage(
          From,
          `📅 Please provide the revised due date and time for this task.  
🕒 *Format:* DD-MM-YYYY HH:MM  
🧪 *Example:* 30-07-2025 14:47
`
        );

        userSessions[From] = {
          step: 8,
          taskId,
          number: allMatchedRow.phone,
        };
        return;
      }

      if (response === "managetaskcompleted") {
        console.log(
          `✅ Marked as completed button clicked for Task ID: ${taskId}`
        );

        const { data: groupedData, error: fetchError } = await supabase
          .from("grouped_tasks")
          .select("id, tasks, name, phone, employerNumber");

        if (fetchError) {
          console.error("❌ Error fetching grouped_tasks:", fetchError);
          const twiml = new MessagingResponse();
          twiml.message("Error: Could not retrieve task data.");
          res.setHeader("Content-Type", "text/xml");
          return res.status(200).send(twiml.toString());
        }

        // Step 2: Find the row containing the task
        const matchedRow = groupedData.find((row) =>
          row.tasks?.some((task) => task.taskId === taskId)
        );

        console.log("matched row inside manage task ❌❌❌❌", matchedRow);

        if (!matchedRow) {
          console.error(`❌ Task with ID ${taskId} not found.`);
          const twiml = new MessagingResponse();
          twiml.message("Error: Task not found.");
          res.setHeader("Content-Type", "text/xml");
          return res.status(200).send(twiml.toString());
        }

        // Step 3: Map tasks and update task_done
        const updatedTasks = matchedRow.tasks.map((task) =>
          task.taskId === taskId ? { ...task, task_done: "Completed" } : task
        );

        // Step 4: Update Supabase
        const { error: updateError } = await supabase
          .from("grouped_tasks")
          .update({ tasks: updatedTasks })
          .eq("id", matchedRow.id);

        if (updateError) {
          console.error("❌ Error updating grouped_tasks:", updateError);
          const twiml = new MessagingResponse();
          twiml.message("Error: Could not mark the task as completed.");
          res.setHeader("Content-Type", "text/xml");
          return res.status(200).send(twiml.toString());
        }

        const completedTaskAssignor = matchedRow.tasks.find(
          (task) => task.taskId === taskId
        );
        console.log(
          "✅✅ Task being marked as completed assignor:",
          completedTaskAssignor
        );

        console.log(`✅ Task with ID ${taskId} marked as Completed.`);

        const updatedFilteredTasks = updatedTasks.filter(
          (task) =>
            task.task_done === "Pending" || task.task_done === "Not Completed"
        );

        console.log(
          "updatedFilteredTasks tasks after completion 🧲🧲🧲🧲",
          updatedFilteredTasks
        );

        completed_templateData = {};

        updatedFilteredTasks.forEach((task, index) => {
          console.log("inside for each =======>>>>>", task);

          completed_templateData[`${index + 4}`] = `${formatDueDate(
            task.due_date
          )}`;
          completed_templateData[
            `${index + 4}_description`
          ] = `${truncateString(task.task_details)}`;
          completed_templateData[`task_${index}`] = task.taskId;
        });

        if (updatedFilteredTasks.length === 0) {
          console.log("length is 0 🧲");

          await sendMessage(From, "✅ Task has been marked as *Completed*");
        } else if (updatedFilteredTasks.length === 1) {
          console.log("length is 1 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HX506bd2d2203a53e5f10e9c31f84f8937" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 2) {
          console.log("length is 2 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HXb79d20bc198cfc9512dd96fdd02b109f" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 3) {
          console.log("length is 3 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HX73edc281f75b87c66e3fc19e83df9c2b" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 4) {
          console.log("length is 4 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HXa7fcc52aefb4a11bb4b693bb4a1fafad" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 5) {
          console.log("length is 5 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HX6eca0139bb905f5209c644a671ebc4e0" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 6) {
          console.log("length is 6 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HX9292a578b0fe74c6a0a0d8acda77b35f" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 7) {
          console.log("length is 7 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HX3fdf00cc3d1843c1405ba095c668f75e" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 8) {
          console.log("length is 8 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HX34f276be3b6b9de6c5d694dec8855a6e" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 9) {
          console.log("length is 9 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HX6be1d3c4e9e4afef531f2c79dc0b1749" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length >= 10) {
          console.log("length is >= 10 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HX63ac3eb36b74d41b1b64f6c207b84507" // Content SID for the List Picker template
          );
        }

        await sendMessage(
          matchedRow.employerNumber,
          null, // No body for template
          true, // isTemplate flag
          {
            1: `*${completedTaskAssignor.task_details}*`,
            2: `*${matchedRow.name}*`,
          },
          process.env.TWILIO_COMPLETED_TASK_ASSIGNOR
        );

        return;
      } else if (response === "noaction") {
        const twiml = new MessagingResponse();
        twiml.message("❌Got it! No response has been recorded for this task");
        res.setHeader("Content-Type", "text/xml");
        return res.status(200).send(twiml.toString());
      }

      if (response === "completed") {
        console.log(
          `✅ Marked as completed button clicked for Task ID: ${taskId}`
        );

        const { data: groupedData, error: fetchError } = await supabase
          .from("grouped_tasks")
          .select("id, tasks, phone, name");

        if (fetchError) {
          console.error("❌ Error fetching grouped_tasks:", fetchError);
          const twiml = new MessagingResponse();
          twiml.message("Error: Could not retrieve task data.");
          res.setHeader("Content-Type", "text/xml");
          return res.status(200).send(twiml.toString());
        }

        // Step 2: Find the row containing the task
        const matchedRow = groupedData.find((row) =>
          row.tasks?.some((task) => task.taskId === taskId)
        );

        console.log("matchedRow for completed tasks 🧲🧲", matchedRow);

        if (!matchedRow) {
          console.error(`❌ Task with ID ${taskId} not found.`);
          const twiml = new MessagingResponse();
          twiml.message("Error: Task not found.");
          res.setHeader("Content-Type", "text/xml");
          return res.status(200).send(twiml.toString());
        }

        // Step 3: Map tasks and update task_done
        const updatedTasks = matchedRow.tasks.map((task) =>
          task.taskId === taskId ? { ...task, task_done: "Completed" } : task
        );

        // Step 4: Update Supabase
        const { error: updateError } = await supabase
          .from("grouped_tasks")
          .update({ tasks: updatedTasks })
          .eq("id", matchedRow.id);

        if (updateError) {
          console.error("❌ Error updating grouped_tasks:", updateError);
          const twiml = new MessagingResponse();
          twiml.message("Error: Could not mark the task as completed.");
          res.setHeader("Content-Type", "text/xml");
          return res.status(200).send(twiml.toString());
        }

        const completedTask = matchedRow.tasks.find(
          (task) => task.taskId === taskId
        );
        console.log("✅✅✅ Task being marked as completed:", completedTask);

        console.log(`✅ Task with ID ${taskId} marked as Completed.`);

        const updatedFilteredTasks = updatedTasks.filter(
          (task) =>
            task.task_done === "Pending" || task.task_done === "Not Completed"
        );

        console.log(
          "updatedFilteredTasks tasks after completion 🧲🧲🧲🧲",
          updatedFilteredTasks
        );

        completed_templateData = {};

        updatedFilteredTasks.forEach((task, index) => {
          console.log("inside for each =======>>>>>", task);

          completed_templateData[`${index + 4}`] = `${formatDueDate(
            task.due_date
          )}`;
          completed_templateData[
            `${index + 4}_description`
          ] = `${truncateString(task.task_details)}`;
          completed_templateData[`task_${index}`] = task.taskId;
        });

        if (updatedFilteredTasks.length === 0) {
          console.log("length is 0 🧲");

          await sendMessage(From, "✅ Task has been marked as *Completed*");
        } else if (updatedFilteredTasks.length === 1) {
          console.log("length is 1 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HXc2d701ea1ea86e0791bfc5cc803f7cf3" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 2) {
          console.log("length is 2 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HXd5b71cd87d8cb60dd597c7415c44a572" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 3) {
          console.log("length is 3 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HX1f505ac03193bfdae5fc33f33cab8f27" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 4) {
          console.log("length is 4 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HXa76c26090646ac8a34292d9e96d3c054" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 5) {
          console.log("length is 5 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HXbb8a2848f73d28c184f0df90a08ae766" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 6) {
          console.log("length is 6 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HXe944a5bbbf36cef5f9dcbe973e5a6d5b" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 7) {
          console.log("length is 7 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HXc2da75538e43aecd3234ee4d9afa16b9" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 8) {
          console.log("length is 8 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HX627691c7bcd830f08862f180d6ce736c" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length === 9) {
          console.log("length is 9 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HXd5ea6c3429dfbbd1c6a206e8a668c54c" // Content SID for the List Picker template
          );
        } else if (updatedFilteredTasks.length >= 10) {
          console.log("length is >= 10 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            completed_templateData,
            "HXe8fbc1b8e7bbc348cf945fd345d6047a" // Content SID for the List Picker template
          );
        }

        sendMessage(
          `whatsapp:+${matchedRow.phone}`,
          null, // No body for template
          true, // isTemplate flag
          {
            1: `*${completedTask.task_details}*`,
          },
          process.env.TWILIO_COMPLETED_TASK_ASSIGNEE
        );

        return;
      } else if (response === "delete") {
        console.log(`🗑️ Delete button clicked for Task ID: ${taskId}`);

        const { data: groupedData, error: fetchError } = await supabase
          .from("grouped_tasks")
          .select("id, tasks, phone");

        if (fetchError) {
          console.error("❌ Error fetching grouped_tasks:", fetchError);
          const twiml = new MessagingResponse();
          twiml.message("Error: Could not retrieve task data.");
          res.setHeader("Content-Type", "text/xml");
          return res.status(200).send(twiml.toString());
        }

        // Step 2: Find the row that contains this task
        const matchedRow = groupedData.find((row) =>
          row.tasks?.some((task) => task.taskId === taskId)
        );

        console.log("matched row after delete 📌📌", matchedRow);

        if (!matchedRow) {
          console.error(`❌ Task with ID ${taskId} not found.`);
          const twiml = new MessagingResponse();
          twiml.message("Error: Task not found.");
          res.setHeader("Content-Type", "text/xml");
          return res.status(200).send(twiml.toString());
        }

        const deletedTask = matchedRow.tasks.find(
          (task) => task.taskId === taskId
        );
        console.log("🗑️ Task being deleted:", deletedTask);

        // Step 3: Filter out the task to delete
        const updatedTasks = matchedRow.tasks.filter(
          (task) => task.taskId !== taskId
        );

        // Step 4: Update the row in Supabase

        const { error: updateError } = await supabase
          .from("grouped_tasks")
          .update({ tasks: updatedTasks })
          .eq("id", matchedRow.id);

        if (updateError) {
          console.error("❌ Error updating grouped_tasks:", updateError);
          const twiml = new MessagingResponse();
          twiml.message("Error: Could not delete the task.");
          res.setHeader("Content-Type", "text/xml");
          return res.status(200).send(twiml.toString());
        }

        console.log(`✅ Task with ID ${taskId} successfully deleted.`);

        const filteredTasks = updatedTasks.filter(
          (task) =>
            task.task_done === "Pending" || task.task_done === "Not Completed"
        );

        console.log("filtered tasks 🧲🧲🧲🧲", filteredTasks);

        delete_templateData = {};

        filteredTasks.forEach((task, index) => {
          console.log("inside for each =======>>>>>", task);

          delete_templateData[`${index + 4}`] = `${formatDueDate(
            task.due_date
          )}`;
          delete_templateData[
            `${index + 4}_description`
          ] = `${truncateString(task.task_details)}`;
          delete_templateData[`task_${index}`] = task.taskId;
        });

        if (filteredTasks.length === 0) {
          console.log("length is 0 🧲");

          await sendMessage(
            From,
            "✅ Task successfully deleted. There are currently no tasks available in database!"
          );
        } else if (filteredTasks.length === 1) {
          console.log("length is 1 🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            delete_templateData,
            "HX66ec97bd29324b104f6328a540098f6b" // Content SID for the List Picker template
          );
        } else if (filteredTasks.length === 2) {
          console.log("length is 2 🧲🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            delete_templateData,
            "HX724615cc471446d22765bb53f2f869d8" // Content SID for the List Picker template
          );
        } else if (filteredTasks.length === 3) {
          console.log("length is 3 🧲🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            delete_templateData,
            "HXdf40ebbc99d2cd0933d0ff791f1857eb" // Content SID for the List Picker template
          );
        } else if (filteredTasks.length === 4) {
          console.log("length is 4 🧲🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            delete_templateData,
            "HXe31d086b68bc6cf2fe302cd7902013e4" // Content SID for the List Picker template
          );
        } else if (filteredTasks.length === 5) {
          console.log("length is 5 🧲🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            delete_templateData,
            "HX5ae2e6433735e9789118a5aed92a9dd2" // Content SID for the List Picker template
          );
        } else if (filteredTasks.length === 6) {
          console.log("length is 6 🧲🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            delete_templateData,
            "HX4086c9ed84ac08d2a617fa26adb78443" // Content SID for the List Picker template
          );
        } else if (filteredTasks.length === 7) {
          console.log("length is 7 🧲🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            delete_templateData,
            "HX152d8bd3304ad449f962c4aae7541b68" // Content SID for the List Picker template
          );
        } else if (filteredTasks.length === 8) {
          console.log("length is 8 🧲🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            delete_templateData,
            "HXbe50bd569fad768cdafcfc9ad69a2ec4" // Content SID for the List Picker template
          );
        } else if (filteredTasks.length === 9) {
          console.log("length is 9 🧲🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            delete_templateData,
            "HXc8003404994f074a484c120e4e91d63c" // Content SID for the List Picker template
          );
        } else if (filteredTasks.length >= 10) {
          console.log("length is >= 10 🧲🧲");

          await sendMessage(
            From,
            null, // No body for template
            true, // isTemplate flag
            delete_templateData,
            "HX50625f295382999d4988676e6b519eca" // Content SID for the List Picker template
          );
        }

        await sendMessage(
          `whatsapp:+${matchedRow.phone}`,
          null, // No body for template
          true, // isTemplate flag
          {
            1: `*${deletedTask.task_details}*`,
          },
          process.env.TWILIO_DELETE_TASK_ASSIGNEE
        );

        return;
      }

      if (!taskId || !["yes", "no"].includes(response.toLowerCase())) {
        console.error("Invalid ButtonPayload format:", buttonPayload);
        const twiml = new MessagingResponse();
        twiml.message(
          "Error: Invalid response. Please use the provided buttons."
        );
        res.setHeader("Content-Type", "text/xml");
        return res.status(200).send(twiml.toString());
      }

      // Fetch task details from Supabase based on taskId
      const { data: groupedData, error } = await supabase
        .from("grouped_tasks")
        .select("name, phone, tasks, employerNumber");

      if (error) {
        console.error("Error fetching grouped_tasks:", error);
        twiml.message("Error: Could not retrieve task details.");
        res.setHeader("Content-Type", "text/xml");
        return res.status(200).send(twiml.toString());
      }

      // Find the row containing the task with the matching taskId
      const matchedRow = groupedData.find((row) =>
        row.tasks?.some((task) => task.taskId === taskId)
      );

      if (!matchedRow) {
        console.error(`No task found for taskId: ${taskId}`);
        twiml.message("Error: Task not found.");
        res.setHeader("Content-Type", "text/xml");
        return res.status(200).send(twiml.toString());
      }

      // Get the specific task
      const matchedTask = matchedRow.tasks.find(
        (task) => task.taskId === taskId
      );

      // Initialize user session with task details
      userSessions[From] = {
        step: 5, // Set to step 5 for handling Yes/No responses
        task: matchedTask.task_details,
        assignee: matchedRow.name,
        fromNumber: matchedRow.employerNumber,
        taskId: taskId,
        conversationHistory: [],
      };

      // Pass the button response to handleUserInput
      await handleUserInput(response.toLowerCase(), From);

      // Respond to Twilio
      res.setHeader("Content-Type", "text/xml");
      return res.status(200);
    }

    if (numMedia > 0 && mediaUrl && mediaType?.startsWith("image/")) {
      const twiml = new MessagingResponse();
      const startTime = Date.now();

      try {
        const fileName = `image_${Date.now()}.${mediaType.split("/")[1]}`;
        const filePath = path.join(__dirname, "Uploads", fileName);

        // Ensure uploads directory exists
        fs.mkdirSync(path.join(__dirname, "Uploads"), { recursive: true });

        // Download the image from Twilio
        const downloadSuccess = await downloadImage(mediaUrl, filePath);
        console.log(
          `Image download ${downloadSuccess ? "successful" : "failed"}`
        );

        if (downloadSuccess) {
          // Upload to Supabase and get public URL
          const supabaseUrl = await uploadToSupabase(filePath, fileName);
          if (supabaseUrl) {
            console.log("inside supabaseURL condition--->");
            const extractedText = await extractTextFromImage(supabaseUrl);
            console.log("extractedText====>", extractedText);

            if (extractedText) {
              console.log("inside extractedText condition--->");
              try {
                const cleanJson = extractedText
                  .replace(/```json\s*/i, "")
                  .replace(/```$/, "")
                  .trim();
                console.log("cleaned json", cleanJson);
                const parsed = JSON.parse(cleanJson);
                console.log("parsed====> ", parsed);

                const success = await insertBakeryOrder(parsed, From);

                console.log("success inside bakery receipt==>", success);

                console.log("Order details extracted successfully:", success);

                if (success) {
                  // Initialize session with extracted task details
                  userSessions[From] = {
                    step: 1, // Start at step 1 for task detail collection
                    task: parsed.tasks[0]?.task_details || "Bakery Order",
                    assignee: parsed.name || "Unknown Assignee",
                    dueDate: parsed.tasks[0]?.due_date?.split(" ")[0] || "", // Extract date if available
                    dueTime: parsed.tasks[0]?.due_date?.split(" ")[1] || "", // Extract time if available
                    reminder_type: parsed.tasks[0]?.reminder_type || "",
                    reminder_frequency:
                      parsed.tasks[0]?.reminder_frequency || null,
                    reminderDateTime: parsed.tasks[0]?.reminderDateTime || null,
                    notes: parsed.tasks[0]?.notes || null, // Store notes from tasks
                    started_at: parsed.tasks[0]?.started_at || null, // Store started_at from tasks
                    assignerNumber: From,
                    conversationHistory: [],
                    taskId: parsed.tasks[0]?.taskId || Date.now().toString(),
                    fromImage: true, // Flag to indicate task originated from an image
                  };

                  // Create a JSON string mimicking user input for handleUserInput
                  const imageTaskDetails = {
                    task: userSessions[From].task,
                    assignee: userSessions[From].assignee,
                    dueDate: userSessions[From].dueDate,
                    dueTime: userSessions[From].dueTime,
                    reminder_type: userSessions[From].reminder_type,
                    reminder_frequency: userSessions[From].reminder_frequency,
                    reminderDateTime: userSessions[From].reminderDateTime,
                    notes: userSessions[From].notes, // Include notes in JSON
                    started_at: userSessions[From].started_at, // Include started_at in JSON
                  };

                  // Send initial message to user
                  sendMessage(From, "Order details extracted successfully! 🎉");

                  // Pass the extracted details to handleUserInput as JSON
                  await handleUserInput(JSON.stringify(imageTaskDetails), From);

                  // Respond to Twilio to acknowledge the message
                  res.setHeader("Content-Type", "text/xml");
                  res.status(200).send(twiml.toString());
                  console.log(
                    `Response sent successfully in ${Date.now() - startTime}ms`
                  );
                  return;
                } else {
                  sendMessage(From, "Error: Could not find assignee.");
                }
              } catch (e) {
                console.error("Failed to parse or insert extracted text:", e);
                twiml.message(
                  `Image received, but failed to process order details.`
                );
              }
            } else {
              console.log("NOT inside extractedText condition--->");

              twiml.message("Image received, but failed to extract text.");
            }
          } else {
            twiml.message("Image received, but failed to upload to Supabase.");
          }

          // Clean up local file
          fs.unlinkSync(filePath);
        } else {
          twiml.message("Image received, but failed to download.");
        }

        res.setHeader("Content-Type", "text/xml");
        res.status(200).send(twiml.toString());
        console.log(
          `Response sent successfully in ${Date.now() - startTime}ms`
        );
        return;
      } catch (error) {
        console.error("Error processing image webhook:", error);
        if (!res.headersSent) {
          res.status(500).send("Internal Server Error");
        }
        return;
      }
    }

    if (
      incomingMsg.toLowerCase().includes("schedule") ||
      (sessions[userNumber] && sessions[userNumber].pendingMeeting)
    ) {
      console.log("MEETING FUNC TRIGGERED!!!");

      if (
        incomingMsg.toLowerCase().includes("task") ||
        incomingMsg.toLowerCase().includes("assign")
      ) {
        // Reset meeting session to allow task assignment

        console.log(
          "MEEEETING FUNCTION TRIGGERED!!!! ASSIGNNN TASKKK WORD DETECTED!!!!"
        );

        delete sessions[userNumber];
        userSessions[userNumber] = {
          step: 0,
          task: "",
          assignee: "",
          dueDate: "",
          dueTime: "",
          assignerNumber: userNumber,
          conversationHistory: [],
        };
        await handleUserInput(incomingMsg, userNumber);
        return res.status(200).send("<Response></Response>");
      }

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

        try {
          await sendMessage(
            userNumber, // Send to userNumber
            null, // No body for template
            true, // isTemplate flag
            {
              1: await shortenUrl(authUrl), // Map {{1}} to shortened URL
            },
            process.env.TWILIO_MEETING_TEMPLATE_SID // Template SID
          );
          // Return empty TwiML response since message is sent via sendMessage
          return res.type("text/xml").send(twiml.toString());
        } catch (error) {
          console.error("Error sending meeting auth template:", error);
          twiml.message(
            "⚠️ Error initiating authentication. Please try again later."
          );
          return res.type("text/xml").send(twiml.toString());
        }
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
- If recurring, always ask for the frequency (e.g., "daily", "weekly", "monthly") and a mandatory end date (e.g., "until 31st Dec 2025"). Do not proceed without a valid end date.
- If the user doesn’t specify an end date, ask them for it. Do not assume one year. Do not proceed until a valid end date is given.
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
          rrule = `RRULE:FREQ=WEEKLY;BYDAY=SA,SU`;
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

async function initializeReminders() {
  console.log("🚫Initializing reminders from database...");
  try {
    // Fetch all reminders from the reminders table
    const { data: reminders, error } = await supabase
      .from("reminders")
      .select("taskId, reminder_frequency, nextReminderTime");

    if (error) {
      console.error("Error fetching reminders:", error);
      return;
    }

    if (!reminders || reminders.length === 0) {
      console.log("No reminders found in database.");
      return;
    }

    console.log(`🚫Found ${reminders.length} reminders to initialize.`);

    for (const reminder of reminders) {
      const { taskId, reminder_frequency, nextReminderTime } = reminder;

      // Skip if already scheduled
      if (cronJobs.has(taskId)) {
        console.log(`Reminder for task ${taskId} already scheduled, skipping.`);
        continue;
      }

      // Fetch task details to determine reminder_type
      const { data: groupedData, error: taskError } = await supabase
        .from("grouped_tasks")
        .select("name, phone, tasks, employerNumber");

      if (taskError) {
        console.error(`Error fetching task for ${taskId}:`, taskError);
        continue;
      }

      const matchedRow = groupedData.find((row) =>
        row.tasks?.some((task) => task.taskId === taskId)
      );

      if (!matchedRow) {
        console.log(`🚫No task found for taskId ${taskId}, skipping reminder.`);
        continue;
      }

      const matchedTask = matchedRow.tasks.find(
        (task) => task.taskId === taskId
      );

      if (
        matchedTask.reminder !== "true" ||
        matchedTask.task_done === "Completed" ||
        matchedTask.task_done === "No" ||
        matchedTask.task_done === "Reminder sent"
      ) {
        console.log(`Task ${taskId} does not need reminders, skipping.`);
        continue;
      }

      // Determine reminder_type (default to recurring if not specified)
      const reminder_type = matchedTask.reminder_type || "recurring";
      const reminderDateTime =
        reminder_type === "one-time" ? matchedTask.reminderDateTime : null;

      // MODIFIED: Updated sendReminder to handle plain text or special reminder based on due time
      const sendReminder = async () => {
        const currentTime = moment().tz("Asia/Kolkata");
        console.log(
          `🚫Sending reminder for task ${taskId} at ${currentTime.format(
            "DD-MM-YYYY HH:mm:ss"
          )} IST`
        );

        if (!matchedRow || !matchedTask) {
          console.log(`🚫Task ${taskId} no longer valid, stopping reminder.`);
          cronJobs.delete(taskId);
          return;
        }

        // NEW: Check if due time is within 15 minutes for recurring reminders
        let templateSid = process.env.TWILIO_REMINDER_TEMPLATE_SID;
        let messageParams = {
          1: matchedTask.task_details,
          2: matchedTask.due_date,
          3: taskId,
        };

        if (reminder_type === "recurring") {
          const dueTime = moment.tz(
            matchedTask.due_date,
            "DD-MM-YYYY HH:mm",
            "Asia/Kolkata"
          );
          const timeToDue = dueTime.diff(currentTime, "minutes");

          if (timeToDue > 15) {
            // NEW: Use plain text template for recurring reminders when due time is more than 15 minutes away
            templateSid = process.env.TWILIO_REMINDER_PLAIN_TEXT;
            messageParams = {
              1: matchedTask.task_details,
              2: extractDate(matchedTask.due_date),
              3: extractTime(matchedTask.due_date),
            };
          }
        }

        console.log(
          `🚫Sending reminder to: ${matchedRow.phone} for task ${taskId} using template ${templateSid}`
        );

        await sendMessage(
          `whatsapp:+${matchedRow.phone}`,
          null,
          true,
          messageParams,
          templateSid
        );

        userSessions[`whatsapp:+${matchedRow.phone}`] = {
          step: 15,
          task: matchedTask.task_details,
          assignee: matchedRow.name,
          fromNumber: matchedRow.employerNumber,
          taskId: taskId,
        };

        // For one-time reminders, mark task to stop further reminders
        if (reminder_type === "one-time") {
          const { data: existingData } = await supabase
            .from("grouped_tasks")
            .select("tasks")
            .eq("name", matchedRow.name.toUpperCase())
            .eq("employerNumber", matchedRow.employerNumber)
            .single();

          const updatedTasks = existingData.tasks.map((task) =>
            task.taskId === taskId ? { ...task, reminder: "false" } : task
          );

          await supabase
            .from("grouped_tasks")
            .update({ tasks: updatedTasks })
            .eq("name", matchedRow.name.toUpperCase())
            .eq("employerNumber", matchedRow.employerNumber);

          cronJobs.delete(taskId);
        }
      };

      if (reminder_type === "one-time" && reminderDateTime) {
        const now = moment().tz("Asia/Kolkata");
        const reminderTime = moment.tz(
          reminderDateTime,
          "DD-MM-YYYY HH:mm",
          "Asia/Kolkata"
        );
        const delay = reminderTime.diff(now);

        if (delay <= 0) {
          console.log(
            `🚫One-time reminder for task ${taskId} is in the past, sending now.`
          );
          await sendReminder();
          continue;
        }

        const timeoutId = setTimeout(async () => {
          await sendReminder();
        }, delay);

        cronJobs.set(taskId, { type: "one-time", timeoutId });
        console.log(
          `🚫Scheduled one-time reminder for task ${taskId} at ${reminderTime.format(
            "DD-MM-YYYY HH:mm:ss"
          )} IST`
        );
      } else {
        // Handle recurring reminders
        const frequencyPattern =
          /(\d+)\s*(minute|min|mins|hour|hr|hrs|hours|day|days)s?/;
        const match = reminder_frequency?.match(frequencyPattern);

        if (!match) {
          console.log(
            `🚫Invalid reminder frequency for task ${taskId}: ${reminder_frequency}`
          );
          continue;
        }

        const quantity = parseInt(match[1], 10);
        let unit = match[2];

        if (
          unit === "minute" ||
          unit === "min" ||
          unit === "mins" ||
          unit === "minutes"
        ) {
          unit = "minutes";
        } else if (
          unit === "hour" ||
          unit === "hr" ||
          unit === "hrs" ||
          unit === "hours"
        ) {
          unit = "hours";
        } else if (unit === "day" || unit === "days") {
          unit = "days";
        }

        const now = moment().tz("Asia/Kolkata");
        const nextReminder = moment.tz(
          nextReminderTime,
          "DD-MM-YYYY HH:mm:ss",
          "Asia/Kolkata"
        );
        const delay = nextReminder.diff(now);

        if (delay <= 0) {
          console.log(
            `🚫Next reminder for task ${taskId} is in the past, sending now and scheduling next.`
          );
          await sendReminder();
          continue;
        }

        // NEW: Schedule special 15-minute-before-due reminder for recurring tasks
        const dueTime = moment.tz(
          matchedTask.due_date,
          "DD-MM-YYYY HH:mm",
          "Asia/Kolkata"
        );
        const fifteenMinutesBeforeDue = dueTime.clone().subtract(15, "minutes");
        const delayForSpecialReminder = fifteenMinutesBeforeDue.diff(now);

        if (delayForSpecialReminder > 0) {
          const specialTimeoutId = setTimeout(async () => {
            console.log(
              `🚫Sending 15-minute-before-due-date reminder for task ${taskId}`
            );

            const { data: groupedDataForSpecial } = await supabase
              .from("grouped_tasks")
              .select("name, phone, tasks, employerNumber");

            const matchedRowSpecial = groupedDataForSpecial.find((row) =>
              row.tasks?.some((task) => task.taskId === taskId)
            );
            if (!matchedRowSpecial) {
              console.log(
                `🚫No task found for taskId ${taskId}, skipping special reminder.`
              );
              return;
            }

            const matchedTaskSpecial = matchedRowSpecial.tasks.find(
              (task) => task.taskId === taskId
            );

            await sendMessage(
              `whatsapp:+${matchedRowSpecial.phone}`,
              null,
              true,
              {
                1: matchedTaskSpecial.task_details,
                2: matchedTaskSpecial.due_date,
                3: taskId,
              },
              process.env.TWILIO_REMINDER_TEMPLATE_SID
            );

            const job = cronJobs.get(taskId);
            if (job?.timeoutId) {
              clearTimeout(job.timeoutId);
              console.log(
                `🚫Cleared recurring reminder timeout for task ${taskId}`
              );
            }
            cronJobs.delete(taskId);

            // Update task to stop further reminders
            const { data: existingData } = await supabase
              .from("grouped_tasks")
              .select("tasks")
              .eq("name", matchedRowSpecial.name.toUpperCase())
              .eq("employerNumber", matchedRowSpecial.employerNumber)
              .single();

            const updatedTasks = existingData.tasks.map((task) =>
              task.taskId === taskId ? { ...task } : task
            );

            await supabase
              .from("grouped_tasks")
              .update({ tasks: updatedTasks })
              .eq("name", matchedRowSpecial.name.toUpperCase())
              .eq("employerNumber", matchedRowSpecial.employerNumber);

            console.log(
              `🚫Stopped further reminders for task ${taskId} after special 15-minute message`
            );
          }, delayForSpecialReminder);

          console.log(
            ` 🚫Scheduled 15-minute-before-due reminder for task ${taskId} at ${fifteenMinutesBeforeDue.format(
              "DD-MM-YYYY HH:mm:ss"
            )} IST`
          );
        } else {
          console.log(
            ` 🚫Skipping 15-minute-before-due-date reminder for task ${taskId} as time is already past.`
          );
        }

        if (unit === "minutes" || unit === "hours") {
          const scheduleReminder = async () => {
            await sendReminder();
            const nextReminderTime = moment()
              .tz("Asia/Kolkata")
              .add(quantity, unit);
            console.log(
              `🚫Scheduling next reminder for task ${taskId} at ${nextReminderTime.format(
                "DD-MM-YYYY HH:mm:ss"
              )} IST`
            );
            await supabase.from("reminders").upsert({
              taskId,
              reminder_frequency,
              nextReminderTime: nextReminderTime.format("DD-MM-YYYY HH:mm:ss"),
            });
            const nextDelay = nextReminderTime.diff(
              moment().tz("Asia/Kolkata")
            );
            const timeoutId = setTimeout(scheduleReminder, nextDelay);
            cronJobs.set(taskId, {
              timeoutId,
              frequency: reminder_frequency,
              type: "recurring",
            });
          };

          const timeoutId = setTimeout(async () => {
            await scheduleReminder();
          }, delay);

          cronJobs.set(taskId, {
            type: "recurring",
            frequency: reminder_frequency,
            timeoutId,
          });
          console.log(
            `🚫Scheduled recurring reminder for task ${taskId} at ${nextReminder.format(
              "DD-MM-YYYY HH:mm:ss"
            )} IST with frequency ${reminder_frequency}`
          );
        } else if (unit === "days") {
          const minute = nextReminder.minute();
          const hour = nextReminder.hour();
          const cronExpression = `${minute} ${hour} */${quantity} * *`;

          const timeoutId = setTimeout(async () => {
            await sendReminder();
            const cronJob = cron.schedule(cronExpression, sendReminder, {
              timezone: "Asia/Kolkata",
            });
            cronJobs.set(taskId, {
              cron: cronJob,
              frequency: reminder_frequency,
              type: "recurring",
            });
            console.log(
              `🚫Scheduled recurring reminders for task ${taskId} with cron ${cronExpression} starting at ${nextReminder.format(
                "DD-MM-YYYY HH:mm:ss"
              )} IST`
            );
          }, delay);

          cronJobs.set(taskId, {
            type: "recurring",
            frequency: reminder_frequency,
            timeoutId,
          });
        }
      }
    }
  } catch (error) {
    console.error("Error initializing reminders:", error);
  }
}

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
    const currentTime = moment().tz("Asia/Kolkata");
    console.log(
      `Sending reminder for task ${taskId} at ${currentTime.format(
        "DD-MM-YYYY HH:mm:ss"
      )} IST`
    );
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

    if (!matchedRow) {
      console.log(
        `No matching task found for task ${taskId}. Stopping reminder.`
      );
      const job = cronJobs.get(taskId);
      if (job?.timeoutId) {
        clearTimeout(job.timeoutId);
      }
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
      const job = cronJobs.get(taskId);
      if (job?.timeoutId) {
        clearTimeout(job.timeoutId);
      }

      if (job?.cron) {
        job.cron.stop();
      }
      cronJobs.delete(taskId);

      await supabase.from("reminders").delete().eq("taskId", taskId);
      return;
    }

    console.log(`Sending reminder to: ${matchedRow.phone} for task ${taskId}`);

    // send TEMPORARY due date and time for one-time reminders

    if (reminder_type === "recurring") {
      // Recurring reminder template
      await sendMessage(
        `whatsapp:+${matchedRow.phone}`,
        null,
        true,
        {
          1: matchedTask.task_details,
          2: extractDate(matchedTask.due_date),
          3: extractTime(matchedTask.due_date),
        },
        process.env.TWILIO_REMINDER_PLAIN_TEXT
      );
    } else {
      // One-time reminder template
      await sendMessage(
        `whatsapp:+${matchedRow.phone}`,
        null,
        true,
        {
          1: matchedTask.task_details,
          2: matchedTask.due_date,
          3: taskId,
        },
        process.env.TWILIO_REMINDER_TEMPLATE_SID
      );
    }

    userSessions[`whatsapp:+${matchedRow.phone}`] = {
      step: 15,
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
      "DD-MM-YYYY HH:mm",
      "Asia/Kolkata"
    );
    // const reminderTimeWithOffset = reminderTime.clone().subtract(20, "minutes");
    const delay = reminderTime.diff(now);

    await supabase.from("reminders").upsert({
      taskId,
      reminder_frequency: "once",
      nextReminderTime: reminderTime.format("DD-MM-YYYY HH:mm:ss"),
    });

    console.log(
      "taskId, reminder_frequency, nextReminderTime",
      taskId,
      reminder_frequency,
      reminderTime.format("DD-MM-YYYY HH:mm:ss")
    );

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
    let unit = match[2];

    if (quantity <= 0) {
      console.log("Invalid reminder frequency quantity:", quantity);
      return res
        .status(400)
        .json({ message: "Reminder frequency quantity must be positive" });
    }

    if (
      unit === "minute" ||
      unit === "min" ||
      unit === "mins" ||
      unit === "minutes"
    ) {
      unit = "minutes";
    } else if (
      unit === "hour" ||
      unit === "hr" ||
      unit === "hrs" ||
      unit === "hours"
    ) {
      unit = "hours";
    } else if (unit === "day" || unit === "days") {
      unit = "days";
    }

    console.log("quantity===>", quantity, "unit===>", unit);

    // Calculate the first reminder time (5 hours from now)
    const now = moment().tz("Asia/Kolkata");
    const firstReminderTime = now.clone().add(quantity, unit);
    const delay = firstReminderTime.diff(now);

    console.log(`Now: ${now.format("DD-MM-YYYY HH:mm:ss")} IST`);
    console.log(
      `First reminder time: ${firstReminderTime.format(
        "DD-MM-YYYY HH:mm:ss"
      )} IST`
    );
    console.log(`Delay: ${delay} ms`);

    if (delay <= 0) {
      console.error(
        `Invalid delay for task ${taskId}: ${delay} ms. Skipping reminder.`
      );
      return res
        .status(400)
        .json({ message: "Invalid reminder time: must be in the future" });
    }

    let cronExpression = "";
    if (unit === "minutes") {
      const scheduleReminder = async () => {
        await sendReminder();
        const nextReminderTime = moment()
          .tz("Asia/Kolkata")
          .add(quantity, "minutes");
        console.log(
          `Scheduling next reminder for task ${taskId} at ${nextReminderTime.format(
            "DD-MM-YYYY HH:mm:ss"
          )} IST`
        );
        // Persist next reminder time
        await supabase.from("reminders").upsert({
          taskId,
          reminder_frequency,
          nextReminderTime: nextReminderTime.format("DD-MM-YYYY HH:mm:ss"),
        });
        const nextDelay = nextReminderTime.diff(moment().tz("Asia/Kolkata"));
        const timeoutId = setTimeout(scheduleReminder, nextDelay);
        cronJobs.set(taskId, {
          timeoutId,
          frequency: reminder_frequency,
          type: "recurring",
        });
      };

      setTimeout(async () => {
        await scheduleReminder();
      }, delay);

      cronJobs.set(taskId, {
        type: "recurring",
        frequency: reminder_frequency,
      });
      console.log(
        `Scheduled first reminder for task ${taskId} at ${firstReminderTime.format(
          "DD-MM-YYYY HH:mm:ss"
        )} IST with frequency ${reminder_frequency}`
      );
      // Persist initial reminder
      await supabase.from("reminders").upsert({
        taskId,
        reminder_frequency,
        nextReminderTime: firstReminderTime.format("DD-MM-YYYY HH:mm:ss"),
      });

      const dueTime = moment.tz(
        dueDateTime,
        "DD-MM-YYYY HH:mm",
        "Asia/Kolkata"
      );
      const twoHoursBeforeDue = dueTime.clone().subtract(15, "minutes");
      const delayForSpecialReminder = twoHoursBeforeDue.diff(
        moment().tz("Asia/Kolkata")
      );

      if (delayForSpecialReminder > 0) {
        setTimeout(async () => {
          console.log(
            `Sending 15-minute-before-due-date reminder for task ${taskId}`
          );

          const { data: groupedDataForSpecial } = await supabase
            .from("grouped_tasks")
            .select("name, phone, tasks, employerNumber");

          const matchedRowSpecial = groupedDataForSpecial.find((row) =>
            row.tasks?.some((task) => task.taskId === taskId)
          );
          if (!matchedRowSpecial) return;

          const matchedTaskSpecial = matchedRowSpecial.tasks.find(
            (task) => task.taskId === taskId
          );

          await sendMessage(
            `whatsapp:+${matchedRowSpecial.phone}`,
            null,
            true,
            {
              1: matchedTaskSpecial.task_details,
              2: matchedTaskSpecial.due_date,
              3: taskId,
            },
            process.env.TWILIO_REMINDER_TEMPLATE_SID
          );

          const job = cronJobs.get(taskId);
          if (job?.timeoutId) {
            clearTimeout(job.timeoutId);
            console.log(
              `Cleared recurring reminder timeout for task ${taskId}`
            );
          }
          cronJobs.delete(taskId);

          // Update task to stop further reminders
          const { data: existingData } = await supabase
            .from("grouped_tasks")
            .select("tasks")
            .eq("name", matchedRowSpecial.name.toUpperCase())
            .eq("employerNumber", matchedRowSpecial.employerNumber)
            .single();

          const updatedTasks = existingData.tasks.map((task) =>
            task.taskId === taskId ? { ...task } : task
          );

          await supabase
            .from("grouped_tasks")
            .update({ tasks: updatedTasks })
            .eq("name", matchedRowSpecial.name.toUpperCase())
            .eq("employerNumber", matchedRowSpecial.employerNumber);

            await supabase.from("reminders").delete().eq("taskId", taskId);
          console.log(
            `Deleted reminder for task ${taskId} from Supabase after special 15-minute message`
          );

          console.log(
            `Stopped further reminders for task ${taskId} after special 15-minute message`
          );
        }, delayForSpecialReminder);

        console.log(
          `Scheduled 15-minute-before-due reminder for task ${taskId} at ${twoHoursBeforeDue.format(
            "DD-MM-YYYY HH:mm:ss"
          )} IST`
        );
      } else {
        console.log(
          `Skipping 15-minute-before-due-date reminder for task ${taskId} as time is already past.`
        );
      }

      const existingJob = cronJobs.get(taskId);

      console.log("existingJob===============>", existingJob);

      return res.status(200).json({ message: "Recurring reminder scheduled" });
    } else if (unit === "hours") {
      const scheduleReminder = async () => {
        await sendReminder();
        const nextReminderTime = moment()
          .tz("Asia/Kolkata")
          .add(quantity, "hours");
        console.log(
          `Scheduling next reminder for task ${taskId} at ${nextReminderTime.format(
            "DD-MM-YYYY HH:mm:ss"
          )} IST`
        );
        await supabase.from("reminders").upsert({
          taskId,
          reminder_frequency,
          nextReminderTime: nextReminderTime.format("DD-MM-YYYY HH:mm:ss"),
        });
        const nextDelay = nextReminderTime.diff(moment().tz("Asia/Kolkata"));
        const timeoutId = setTimeout(scheduleReminder, nextDelay);
        cronJobs.set(taskId, {
          timeoutId,
          frequency: reminder_frequency,
          type: "recurring",
        });
      };

      const timeoutId = setTimeout(async () => {
        await scheduleReminder();
      }, delay);

      cronJobs.set(taskId, {
        type: "recurring",
        frequency: reminder_frequency,
        timeoutId,
      });
      console.log(
        `Scheduled first reminder for task ${taskId} at ${firstReminderTime.format(
          "DD-MM-YYYY HH:mm:ss"
        )} IST with frequency ${reminder_frequency}`
      );
      await supabase.from("reminders").upsert({
        taskId,
        reminder_frequency,
        nextReminderTime: firstReminderTime.format("DD-MM-YYYY HH:mm:ss"),
      });

      const dueTime = moment.tz(
        dueDateTime,
        "DD-MM-YYYY HH:mm",
        "Asia/Kolkata"
      );
      const twoHoursBeforeDue = dueTime.clone().subtract(15, "minutes");
      const delayForSpecialReminder = twoHoursBeforeDue.diff(
        moment().tz("Asia/Kolkata")
      );

      if (delayForSpecialReminder > 0) {
        setTimeout(async () => {
          console.log(
            `Sending 15-minute-before-due-date reminder for task ${taskId}`
          );

          const { data: groupedDataForSpecial } = await supabase
            .from("grouped_tasks")
            .select("name, phone, tasks, employerNumber");

          const matchedRowSpecial = groupedDataForSpecial.find((row) =>
            row.tasks?.some((task) => task.taskId === taskId)
          );
          if (!matchedRowSpecial) return;

          const matchedTaskSpecial = matchedRowSpecial.tasks.find(
            (task) => task.taskId === taskId
          );

          await sendMessage(
            `whatsapp:+${matchedRowSpecial.phone}`,
            null,
            true,
            {
              1: matchedTaskSpecial.task_details,
              2: matchedTaskSpecial.due_date,
              3: taskId,
            },
            process.env.TWILIO_REMINDER_TEMPLATE_SID
          );

          const job = cronJobs.get(taskId);
          if (job?.timeoutId) {
            clearTimeout(job.timeoutId);
            console.log(
              `Cleared recurring reminder timeout for task ${taskId}`
            );
          }
          cronJobs.delete(taskId);

          // Update task to stop further reminders
          const { data: existingData } = await supabase
            .from("grouped_tasks")
            .select("tasks")
            .eq("name", matchedRowSpecial.name.toUpperCase())
            .eq("employerNumber", matchedRowSpecial.employerNumber)
            .single();

          const updatedTasks = existingData.tasks.map((task) =>
            task.taskId === taskId ? { ...task } : task
          );

          await supabase
            .from("grouped_tasks")
            .update({ tasks: updatedTasks })
            .eq("name", matchedRowSpecial.name.toUpperCase())
            .eq("employerNumber", matchedRowSpecial.employerNumber);

            await supabase.from("reminders").delete().eq("taskId", taskId);
          console.log(
            `Deleted reminder for task ${taskId} from Supabase after special 15-minute message`
          );

          console.log(
            `Stopped further reminders for task ${taskId} after special 15-minute message`
          );
        }, delayForSpecialReminder);

        console.log(
          `Scheduled 15-minute-before-due reminder for task ${taskId} at ${twoHoursBeforeDue.format(
            "DD-MM-YYYY HH:mm:ss"
          )} IST`
        );
      } else {
        console.log(
          `Skipping 15-minute-before-due-date reminder for task ${taskId} as time is already past.`
        );
      }

      const existingJob = cronJobs.get(taskId);

      console.log("existingJob===============>", existingJob);
      return res.status(200).json({ message: "Recurring reminder scheduled" });
    } else if (unit === "days") {
      const scheduleReminder = async () => {
        await sendReminder();
        const nextReminderTime = moment()
          .tz("Asia/Kolkata")
          .add(quantity, "days")
          .set({
            hour: firstReminderTime.hour(),
            minute: firstReminderTime.minute(),
            second: 0,
          });
        console.log(
          `Scheduling next reminder for task ${taskId} at ${nextReminderTime.format(
            "DD-MM-YYYY HH:mm:ss"
          )} IST`
        );
        await supabase.from("reminders").upsert({
          taskId,
          reminder_frequency,
          nextReminderTime: nextReminderTime.format("DD-MM-YYYY HH:mm:ss"),
        });
        const nextDelay = nextReminderTime.diff(moment().tz("Asia/Kolkata"));
        const timeoutId = setTimeout(scheduleReminder, nextDelay);
        cronJobs.set(taskId, {
          timeoutId,
          frequency: reminder_frequency,
          type: "recurring",
        });
      };

      const timeoutId = setTimeout(async () => {
        await scheduleReminder();
      }, delay);

      cronJobs.set(taskId, {
        type: "recurring",
        frequency: reminder_frequency,
        timeoutId,
      });
      console.log(
        `Scheduled first reminder for task ${taskId} at ${firstReminderTime.format(
          "DD-MM-YYYY HH:mm:ss"
        )} IST with frequency ${reminder_frequency}`
      );
      await supabase.from("reminders").upsert({
        taskId,
        reminder_frequency,
        nextReminderTime: firstReminderTime.format("DD-MM-YYYY HH:mm:ss"),
      });

      const dueTime = moment.tz(
        dueDateTime,
        "DD-MM-YYYY HH:mm",
        "Asia/Kolkata"
      );
      const twoHoursBeforeDue = dueTime.clone().subtract(15, "minutes");
      const delayForSpecialReminder = twoHoursBeforeDue.diff(
        moment().tz("Asia/Kolkata")
      );

      if (delayForSpecialReminder > 0) {
        setTimeout(async () => {
          console.log(
            `Sending 15-minute-before-due-date reminder for task ${taskId}`
          );

          const { data: groupedDataForSpecial } = await supabase
            .from("grouped_tasks")
            .select("name, phone, tasks, employerNumber");

          const matchedRowSpecial = groupedDataForSpecial.find((row) =>
            row.tasks?.some((task) => task.taskId === taskId)
          );
          if (!matchedRowSpecial) return;

          const matchedTaskSpecial = matchedRowSpecial.tasks.find(
            (task) => task.taskId === taskId
          );

          await sendMessage(
            `whatsapp:+${matchedRowSpecial.phone}`,
            null,
            true,
            {
              1: matchedTaskSpecial.task_details,
              2: matchedTaskSpecial.due_date,
              3: taskId,
            },
            process.env.TWILIO_REMINDER_TEMPLATE_SID
          );

          const job = cronJobs.get(taskId);
          if (job?.timeoutId) {
            clearTimeout(job.timeoutId);
            console.log(
              `Cleared recurring reminder timeout for task ${taskId}`
            );
          }
          cronJobs.delete(taskId);

          // Update task to stop further reminders
          const { data: existingData } = await supabase
            .from("grouped_tasks")
            .select("tasks")
            .eq("name", matchedRowSpecial.name.toUpperCase())
            .eq("employerNumber", matchedRowSpecial.employerNumber)
            .single();

          const updatedTasks = existingData.tasks.map((task) =>
            task.taskId === taskId ? { ...task } : task
          );

          await supabase
            .from("grouped_tasks")
            .update({ tasks: updatedTasks })
            .eq("name", matchedRowSpecial.name.toUpperCase())
            .eq("employerNumber", matchedRowSpecial.employerNumber);

            await supabase.from("reminders").delete().eq("taskId", taskId);
          console.log(
            `Deleted reminder for task ${taskId} from Supabase after special 15-minute message`
          );
          
          console.log(
            `Stopped further reminders for task ${taskId} after special 15-minute message`
          );
        }, delayForSpecialReminder);

        console.log(
          `Scheduled 15-minute-before-due reminder for task ${taskId} at ${twoHoursBeforeDue.format(
            "DD-MM-YYYY HH:mm:ss"
          )} IST`
        );
      } else {
        console.log(
          `Skipping 15-minute-before-due-date reminder for task ${taskId} as time is already past.`
        );
      }

      const existingJob = cronJobs.get(taskId);

      console.log("existingJob===============>", existingJob);
      return res.status(200).json({ message: "Recurring reminder scheduled" });
    } else {
      console.log("Unsupported frequency unit:", unit);
      return res.status(400).json({ message: "Unsupported frequency unit" });
    }
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  makeTwilioRequest();
  initializeReminders();
});

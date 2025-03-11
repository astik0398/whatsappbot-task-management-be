const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { OpenAI } = require("openai");
const supabase = require("./supabaseClient");
require("dotenv").config();
const cron = require('node-cron')
const cors = require('cors')

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

app.use(cors())

let allData = [];
let userSessions = {};
let assignerMap = []

async function getAllTasks() {
  const { data, error } = await supabase.from("tasks").select("*");
  if (error) throw error;
  console.log("data==>", data);
  return data;
}
async function main() {
  allData = await getAllTasks();
  console.log("allData==>", allData);
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

  assignerMap.push(From)

  if (session.step === 5) {
    if (userMessage.toLowerCase() === 'yes') {

      const task = session.task;
      const { data, error } = await supabase
        .from("tasks")
        .update({ task_done: "Completed" })
        .eq("tasks", task)
        .single();

      if (error) {
        console.error("Error updating task:", error);
        sendMessage(From, "Sorry, there was an error marking the task as completed.");
      } else {
        sendMessage(From, "Thank you! The task has been marked as completed!");
        sendMessage(assignerMap[0], `The task "${task}" was completed.`);
      }

      delete userSessions[From];

    } else if (userMessage.toLowerCase() === 'no') {

      sendMessage(From, "Why has the task not been completed? Please provide a reason.");
      
      session.step = 6;
    } else {
      sendMessage(From, "Please respond with 'Yes' or 'No'.");
    }
  } else if (session.step === 6) {
    const reason = userMessage.trim();
    const task = session.task;

    const { data, error } = await supabase
      .from("tasks")
      .update({ task_done: "Not Completed", reason: reason })
      .eq("tasks", task)
      .single();

    if (error) {
      console.error("Error updating task with reason:", error);
      sendMessage(From, "Sorry, there was an error saving the reason.");
    } else {
      sendMessage(From, "Your response has been sent to the assigner.");
      sendMessage(assignerMap[0], `The task "${session.task}" was not completed. Reason: ${reason.trim()}`);

    }

    delete userSessions[From];
  } else{
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
For due times:
- If the user provides a time in "AM/PM" format (e.g., "6 PM" or "6 AM"),
convert it into the 24-hour format:
- "6 AM" becomes "06:00"
- "6 PM" becomes "18:00"
- Ensure the output time is always in the 24-hour format (HH:mm).
Conversation history: ${JSON.stringify(conversationHistory)}
User input: ${userMessage}
`;
  console.log("we are here===> 3");
  try {
    const response = await openai.chat.completions.create({
      model: "ft:gpt-3.5-turbo-0125:test:task-bot:B9mo0E4N",
      messages: [
        {"role": "system", "content": "You are a task manager bot that collects task details from users via WhatsApp."},
        {"role": "user", "content": "The task is Go through Twilio setup, assigned to Astik, due date 4th Sept 2026 5pm, reminder every 3 minutes."}
      ]
    });
    console.log("we are here===> 4");
    const botReply = response.choices[0].message.content;
    session.conversationHistory = conversationHistory;
    console.log("we are here===> 5", botReply);
    
    if(botReply[0]==='{'){
      const taskDetails = JSON.parse(botReply)

      sendMessage(From, `Thank you for providing the task details. Let's summarize the task:

      Task: ${taskDetails.task}
      Assignee: ${taskDetails.assignee}
      Due Date: ${taskDetails.dueDate}
      Due Time: ${taskDetails.dueTime}
     Reminder Frequency: ${taskDetails.reminder_frequency}`)
    }else{
      sendMessage(From, botReply);
    }
    
    if(botReply[0]==='{'){
      try {
        const taskData = JSON.parse(botReply);
        const assignedPerson = allData.find(
          (person) =>
            person.name.toLowerCase() === taskData.assignee.toLowerCase()
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
                  reminder: false,
                  task_done: "Pending",
                  due_date: dueDateTime,
                  reminder_frequency: taskData.reminder_frequency
                },
              ])
              .eq("name", taskData.assignee)
              .single();
            console.log("Matching Task:", data, error);
            if (error) {
              console.error("Error inserting task into Supabase:", error);
            } else {
              console.log("Task successfully added to Supabase.");
              sendMessage(
                From,
                `Task assigned to
  ${taskData.assignee}:"${taskData.task}" with a due date of
  ${dueDateTime}`
              );
              sendMessage(
                `whatsapp:+${assignedPerson.phone}`,
                `Hello
  ${taskData.assignee}, a new task has been assigned to
  you:"${taskData.task}".\n\nDeadline: ${dueDateTime}`
              );
              delete userSessions[From];
              session.conversationHistory = [];
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
async function makeTwilioRequest() {
  app.post("/whatsapp", async (req, res) => {
    const { Body, From } = req.body;
    const userMessage = Body.trim();
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

let isCronRunning = false; // Track if the cron job is active

app.post('/update-reminder', async (req, res) => {

  const {reminder_frequency} = req.body
  
  console.log('inside be update-reminder req.body', reminder_frequency);
  
    if (isCronRunning) {
        console.log("Cron job already running. Ignoring duplicate trigger.");
        return res.status(200).json({ message: "Reminder already scheduled" });
    }

    isCronRunning = true;

    const frequencyPattern = /(\d+)\s*(minute|hour|day)s?/;
    const match = reminder_frequency.match(frequencyPattern);

    console.log('frequencyPattern, match',frequencyPattern, match);
    
  
  if (!match) {
    console.log("Invalid reminder frequency format");
    return res.status(400).json({ message: "Invalid reminder frequency format" });
  }

  const quantity = parseInt(match[1], 10); // Extract the numeric part
  const unit = match[2]; // Extract the unit (minute, hour, day)

  console.log('quantity, unit',quantity, unit);

  let cronExpression = "";

  // Construct the cron expression based on the unit
  if (unit === 'minute') {
    cronExpression = `*/${quantity} * * * *`; // Every X minutes
  } else if (unit === 'hour') {
    cronExpression = `0 */${quantity} * * *`; // Every X hours, at the start of the hour
  } else if (unit === 'day') {
    cronExpression = `0 0 */${quantity} * *`; // Every X days, at midnight
  } else {
    console.log("Unsupported frequency unit");
    return res.status(400).json({ message: "Unsupported frequency unit" });
  }

    cron.schedule(cronExpression, async () => {
        console.log("Checking for pending reminders...");

        // const now = new Date();
        // const tenMinutesLater = new Date(now.getTime() + 10 * 60 * 1000).toISOString().slice(0, 16);

        const { data: tasks, error } = await supabase
            .from("tasks")
            .select("*")
            .eq("reminder", true)
            .neq("task_done", "Completed")
            .neq("task_done", "No")
            .neq("task_done", "Reminder sent") 
            .not("tasks", "is", null)
            .neq("tasks", "");

        if (error) {
            console.error("Error fetching reminders:", error);
            return;
        }

        console.log(`Found ${tasks.length} tasks to remind`);

        for (const task of tasks) {
            console.log("Sending reminder to:", task.phone);
            sendMessage(
                `whatsapp:+${task.phone}`,
                `Reminder: Has the task "${task.tasks}" assigned to you been completed yet? Reply with Yes or No.`
            );

            userSessions[`whatsapp:+${task.phone}`] = { step: 5, task: task.tasks };

            // Optional: Mark the task as "Reminder sent" to avoid resending it
            // await supabase
            //     .from("tasks")
            //     .update({ task_done: "Reminder sent" })
            //     .eq("id", task.id);
        }
    });

    res.status(200).json({ message: "Reminder scheduled" });
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  makeTwilioRequest();
});

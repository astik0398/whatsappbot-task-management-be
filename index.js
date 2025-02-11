require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const supabase = require("./supabaseClient");
const cron = require("node-cron");

const app = express();
const port = process.env.PORT || 8000;

async function getAllTasks() {
  const { data, error } = await supabase.from("tasks").select("*");
  if (error) throw error;
  return data;
}

const client = new twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

let userSessions = {}; 
let allData = [];
let assignerMap = []; // Store assigner's phone numbers separately

async function main() {
  allData = await getAllTasks();
  makeTwilioRequest();
}

main();

function makeTwilioRequest() {
  app.post("/whatsapp", async (req, res) => {
    const { Body, From } = req.body;
    const userMessage = Body.trim().toLowerCase();

    if (!userSessions[From]) {
        userSessions[From] = { step: 0, task: "", assignee: "", dueDate: "", dueTime: "", assignerNumber:From };
    }

    let session = userSessions[From];

    if (userMessage === "hi") {
        session.step = 1;
        sendMessage(From, "What is the task?");
        assignerMap.push(From)
    } 
    else if (session.step === 1) {
        session.task = Body.trim();
        session.step = 2;
        sendMessage(From, "Whom is this task assigned to?");
    } 
    else if (session.step === 2) {
        session.assignee = Body.trim();
        const assignedPerson = allData.find((person) => person.name.toLowerCase() === session.assignee.toLowerCase());

        if (assignedPerson) {
            session.step = 3;
            sendMessage(From, "What is the due date? (Format: YYYY-MM-DD)");
        } else {
            sendMessage(From, "Person not found. Please enter a valid name.");
            session.step = 2;
        }
    } 
    else if (session.step === 3) {
        session.dueDate = Body.trim();
        session.step = 4;
        sendMessage(From, "What is the due time? (Format: HH:MM, 24-hour)");
    } 
    else if (session.step === 4) {
        session.dueTime = Body.trim();
        const assignedPerson = allData.find((person) => person.name.toLowerCase() === session.assignee.toLowerCase());

        console.log('step 4--->',assignerMap);
        
        if (assignedPerson) {
            let dueDateTime = `${session.dueDate} ${session.dueTime}`;
            assignedPerson.tasks = session.task;

            await supabase
                .from("tasks")
                .update({ tasks: session.task, due_date: dueDateTime, task_done: "Pending", reminder: false })
                .eq("name", assignedPerson.name);

            sendMessage(From, `Task assigned to ${assignedPerson.name}: "${session.task}" with a due date of ${dueDateTime}`);

            sendMessage(
                `whatsapp:+${assignedPerson.phone}`,
                `Hello ${assignedPerson.name}, a new task has been assigned to you: "${session.task}".\n\nDeadline: ${dueDateTime}`
            );

            delete userSessions[From];
        } else {
            sendMessage(From, "Error: Could not find assignee.");
        }
    } 

    else if (session.step === 5) {
        console.log('step 5--->',assignerMap);

        const assignedPerson = allData.find((person) => `whatsapp:+${person.phone}` === From);
        if (!assignedPerson) return res.sendStatus(200);

        if (userMessage === "yes") {
            await supabase
                .from("tasks")
                .update({ task_done: "Yes" })
                .eq("name", assignedPerson.name);

            sendMessage(From, "Thank you! The task has been marked as completed.");

            sendMessage(assignerMap[0], `The task "${session.task}" assigned to ${assignedPerson.name} was completed.`);

            delete userSessions[From];
        } 
        else if (userMessage === "no") {
            sendMessage(From, "Please provide a reason for not completing the task yet.");
            session.step = 6;
        }
    } 

    else if (session.step === 6) {
        const assignedPerson = allData.find((person) => `whatsapp:+${person.phone}` === From);

        if (!assignedPerson) return res.sendStatus(200);

        sendMessage(assignerMap[0], `The task "${session.task}" assigned to ${assignedPerson.name} was not completed. Reason: ${Body.trim()}`);

        console.log(`No, ${Body.trim()}`);
        
        await supabase
            .from("tasks")
            .update({ task_done: `No, ${Body.trim()}` })
            .eq("name", assignedPerson.name);

        sendMessage(From, "Your response has been sent to the assigner.");
        delete userSessions[From];
    }

    res.end();
});

}

function sendMessage(to, message) {
  client.messages
    .create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
      body: message,
    })
    .catch((err) => console.error("Error sending message:", err));
}

app.post('/update-reminder', async()=> {
  cron.schedule("* * * * *", async () => {
    console.log("Checking for pending reminders...");
  
    const now = new Date();
    const tenMinutesLater = new Date(now.getTime() + 10 * 60 * 1000).toISOString().slice(0, 16);
  
    console.log("Checking for tasks due within 10 minutes", tenMinutesLater);
  
    const { data: tasks, error } = await supabase
        .from("tasks")
        .select("*")
        .neq("task_done", "Yes")
        .neq("task_done", "No")
        .neq("task_done", "Reminder sent") 
        .not("tasks", "is", null)
        .neq("tasks", "")
      //   .lte("due_date", tenMinutesLater);
  
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
  
      //   await supabase
      //       .from("tasks")
      //       .update({ task_done: "Reminder sent" })
      //       .eq("id", task.id);
  
        userSessions[`whatsapp:+${task.phone}`] = { step: 5, task: task.tasks };
    }
  });
})


app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});

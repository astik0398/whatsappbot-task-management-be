const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { OpenAI } = require("openai");
require("dotenv").config();
const app = express();
const port = process.env.PORT || 8000;
const supabase = require('./supabaseClient')

const openai = new OpenAI({
apiKey: process.env.OPENAI_API_KEY,
});
const client = new twilio(process.env.TWILIO_ACCOUNT_SID,
process.env.TWILIO_AUTH_TOKEN);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

let allData = []
let userSessions = {};

async function getAllTasks() {
  const { data, error } = await supabase.from("tasks").select("*");
  if (error) throw error;
  console.log('data==>',data);
  
  return data;
}

async function main() {
  allData = await getAllTasks();
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
  res.status(200).json({ message: "Tasks refreshed successfully", tasks: allData });
});

async function extractMeaning(userMessage, context) {
try {
const prompt = `
You are a smart AI that extracts specific information from the user's response based on the
given context.
Extract the most relevant part only and return it as a JSON response.
Context: ${context}
User response: "${userMessage}"
Respond strictly in JSON format without additional text.

Example outputs:
- If extracting a task: { "task": "finish the homepage design" }
- If extracting an assignee: { "assignee": "Astik" }
- If extracting a due date: { "dueDate": "28th Feb" }
- If extracting a due time: { "dueTime": "8 PM" }

For due dates:
- If the user provides a day and month (e.g., "28th Feb" or "28 February"), convert it into the current year (e.g., "2025-02-28").
- If the user provides a full date (e.g., "28th Feb 2025"), return it as is.
- If no year is provided, assume the current year and return the date in the format YYYY-MM-DD.

For due times:
- If the user provides a time in "AM/PM" format (e.g., "6 PM" or "6 AM"), convert it into the 24-hour format:
  - "6 AM" becomes "06:00"
  - "6 PM" becomes "18:00"
- Ensure the output time is always in the 24-hour format (HH:mm).
`;

const response = await openai.chat.completions.create({
model: "gpt-3.5-turbo",
messages: [{ role: "system", content: prompt }],
});

return JSON.parse(response.choices[0].message.content);

} catch (error) {
console.error("Error extracting meaning:", error);
return null;
}
}

async function handleUserInput(userMessage, From) {
if (!userSessions[From]) {
userSessions[From] = { step: 0, task: "", assignee: "", dueDate: "", dueTime: "" };
}
const session = userSessions[From];
switch (session.step) {
case 0:
sendMessage(From, "What is the task?");
session.step = 1;
break;
case 1:
const taskDetails = await extractMeaning(userMessage, "Extract only the task description.");
session.task = taskDetails?.task || userMessage;
sendMessage(From, "Whom is this task assigned to?");
session.step = 2;
break;
case 2:
const assigneeDetails = await extractMeaning(userMessage, "Extract only the assignee's name.");
session.assignee = assigneeDetails?.assignee || userMessage;
sendMessage(From, "What is the due date?");
session.step = 3;
break;
case 3:
const dueDateDetails = await extractMeaning(userMessage, "Extract only the due date.");
session.dueDate = dueDateDetails?.dueDate || userMessage;
sendMessage(From, "By what time do you want this to get done?");
session.step = 4;
break;
case 4:
const dueTimeDetails = await extractMeaning(userMessage, "Extract only the due time.");
session.dueTime = dueTimeDetails?.dueTime || userMessage;
sendMessage(
From,
`Task Summary:\n\nTask: ${session.task}\nAssigned To: ${session.assignee}\nDue Date:
${session.dueDate}\nDue Time: ${session.dueTime}\n\nIs this correct? (yes/no)`
);
session.step = 5;
break;
case 5:
if (userMessage.toLowerCase() === "yes") {

  const assignedPerson = allData.find((person) => person.name.toLowerCase() === session.assignee.toLowerCase());

  console.log('assignedPerson--->',assignedPerson);
  console.log('allData--->',allData);

  if(assignedPerson){
    let dueDateTime = `${session.dueDate} ${session.dueTime}`;

    await supabase.from('tasks')
    .update({tasks: session.task, reminder: false, task_done: 'Pending', due_date: dueDateTime})
    .eq('name', assignedPerson.name)

    sendMessage(From, `Task assigned to ${assignedPerson.name}: "${session.task}" with a due date of ${dueDateTime}`);

    sendMessage(
      `whatsapp:+${assignedPerson.phone}`,
      `Hello ${assignedPerson.name}, a new task has been assigned to you: "${session.task}".\n\nDeadline: ${dueDateTime}`
  );

  delete userSessions[From];
  }

  else {
    sendMessage(From, "Error: Could not find assignee.");
}

} else {
sendMessage(From, "Let's start over. What is the task?");
session.step = 1;
}
break;
default:
sendMessage(From, "I'm not sure what you're trying to do. Let's start over. What is thetask?");
session.step = 1;
break;
}
}

function sendMessage(to, message) {
client.messages
.create({ from: process.env.TWILIO_PHONE_NUMBER, to, body: message })
.then((msg) => console.log("Message sent:", msg.sid))
.catch((err) => console.error("Error sending message:", err));
}
app.post("/whatsapp", async (req, res) => {
const { Body, From } = req.body;
await handleUserInput(Body.trim(), From);
res.end();
});
app.listen(port, () => {
console.log(`Server running on port ${port}`);
});
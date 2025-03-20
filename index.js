const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const { OpenAI } = require("openai");
const supabase = require("./supabaseClient");
require("dotenv").config();
const cron = require('node-cron')
const cors = require('cors');
const { default: axios } = require("axios");
const fs = require('fs');

const app = express();
const port = process.env.PORT || 8000;
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
const client = new twilio(
  "AC91853af086d6fab38c6e8d539d5f36a9",
  "e00c6f595c26862fc19f1a8082e8c700"
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
      model: "gpt-4-turbo",
      messages: [{ role: "system", content: prompt }],
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

async function downloadMedia(mediaUrl, messageSid) {
  try {
      // Twilio's Account SID and Auth Token
      const accountSid = 'AC91853af086d6fab38c6e8d539d5f36a9';
      const authToken = 'e00c6f595c26862fc19f1a8082e8c700';

      // Create the authorization header
      const authHeader = 'Basic ' + Buffer.from(accountSid + ':' + authToken).toString('base64');

      // Send a GET request to the media URL with Basic Authentication header
      const mediaResponse = await axios.get(mediaUrl, {
          responseType: 'arraybuffer',  // Important for downloading binary data
          headers: {
              'Authorization': authHeader
          }
      });

      const uniqueId = Date.now().toString() + Math.random().toString(36).substring(2, 15);
      
      const {data, error} = await supabase.storage.from('voice-messages').upload(uniqueId, mediaResponse.data, {
        contentType: 'audio/mp3',  // Set the content type (or adjust based on media type)
        upsert: true,  // Optional: To overwrite existing files with the same name
    })

    const publicURL = `https://rxmjzmgvxbotzfqhidzd.supabase.co/storage/v1/object/public/${data.fullPath}`

    if (error) {
      console.error('Error uploading media to Supabase:', error);
  } else {
      console.log(`Voice message uploaded to Supabase: ${uniqueId}`);
      return publicURL
  }

  } catch (error) {
      console.error('Error downloading media:', error);
  }
}

async function makeTwilioRequest() {
  app.post("/whatsapp", async (req, res) => {
    const { Body, From } = req.body;

    const mediaUrl = req.body.MediaUrl0;
    const mediaType = req.body.MediaContentType0;

    let userMessage = Body.trim();

    console.log('mediaUrl - mediaType', mediaUrl ,mediaType);

    if (mediaUrl && mediaType && mediaType.startsWith('audio')) {
      console.log(`Received a voice message from`);
      console.log(`Media URL: ${mediaUrl}`);

      // Download the voice message
      const audioUrl = await downloadMedia(mediaUrl, From);

      console.log('audioUrl', audioUrl);

      const apiKey = 'ww-9CTz77OQJ36ebmDirGWUvxSyOMbrai47CiFq3JhAFKEPFpUyOUcdM5';
      const requestBody = {
        inputs: {
          voice_over: {
            type: 'audio',
            audio_url: audioUrl, 
            transcript: "Your transcript here"
          }
        },
        version: '^1.0'
      };

      const response = await axios.post(
        'https://app.wordware.ai/api/released-app/d563e981-8c21-4b38-8201-45f319e4aac9/run',
        requestBody,
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json', 
          },
        }
      );
      console.log('res====?>', response.data);
      const responseValue = response.data.trim().split('\n');

      let parsedChunks = responseValue.map(chunk => JSON.parse(chunk));

      console.log('parsedChunks length', parsedChunks[parsedChunks.length-1]);

      const cleanText = parsedChunks[parsedChunks.length-1].value.values['Speech-to-text with Deepgram'].output.transcript
      console.log('actual audio--->', cleanText);

      const cleanedTranscript = cleanText.replace(/^\n?Speaker \d+: /, '').trim();

      console.log('cleanedTranscript=====>',cleanedTranscript);

  }

  // Respond with an HTTP 200 status
  res.status(200).send('<Response></Response>');
    
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

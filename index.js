// Import the modules
var express = require("express");
var bodyParser = require('body-parser');
var multer = require('multer');
var path = require('path');
var fs = require("fs");
const WaveFile = require('wavefile').WaveFile;
var sdk = require("microsoft-cognitiveservices-speech-sdk");
var ffmpegPath = require('ffmpeg-static');
var ffmpeg = require('fluent-ffmpeg');

// Set ffmpeg path for fluent-ffmpeg
ffmpeg.setFfmpegPath(ffmpegPath);

// App Variables & configuration
var app = express();
var router = express.Router();
const port = process.env.PORT || 8080;

app.use(bodyParser.json());
app.use(express.static('public'));
app.engine('html', require('ejs').renderFile);
app.set('view engine', 'html');
app.set('views', __dirname + '/views');
var path1 = __dirname + '/views/';
router.use(function (req, res, next) {
    console.log("/" + req.method);
    next();
});
app.use("/", router);

// Cognitive Service Key and variables (replace with environment variables in production)
var subscriptionKey = "8a7c6f19ff804c539533f7d5b0cebbdf";  // Replace with your actual subscription key
var serviceRegion = "eastus";  // Replace with your region
var selectedlang;

// Ensure the uploads directory exists
var uploadDir = './public/uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
    console.log('Created uploads directory');
}

// File upload variables
var storage = multer.diskStorage({
    destination: function (req, file, callback) {
        callback(null, './public/uploads');
    },
    filename: function (req, file, callback) {
        callback(null, file.originalname);
    }
});
var upload = multer({ storage: storage });

//// Routes Definitions
app.get("/", function (req, res) {
    res.sendFile(path1 + "index.html");
});

app.post('/', upload.single('userFile'), async function (req, res) {
    try {
        var htmlBody = req.body;
        console.log("Selected language: ", htmlBody.langsel);
        selectedlang = htmlBody.langsel;

        // File paths
        var filePath = "./public/uploads/" + req.file.filename;
        var outputWavPath = "./public/uploads/audio.wav";  // ชื่อไฟล์ที่ต้องการให้เป็น audio.wav เสมอ

        // แปลงไฟล์ทั้งหมดเป็น audio.wav ไม่ว่าจะเป็นไฟล์ประเภทใด
        await convertToWav(filePath, outputWavPath);

        // ลบไฟล์ต้นฉบับหลังแปลงเสร็จ
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error('Error deleting original file: ', err.message);
            } else {
                console.log('Original file deleted successfully.');
            }
        });

        // Set Transfer-Encoding to chunked to allow progressive responses
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Content-Type', 'text/plain');

        // Process the WAV file
        await processAudio(outputWavPath, res);

        // ลบไฟล์ audio.wav หลังการประมวลผลเสร็จสิ้น
        fs.unlink(outputWavPath, (err) => {
            if (err) {
                console.error('Error deleting audio.wav: ', err.message);
            } else {
                console.log('audio.wav file deleted successfully.');
            }
        });

        // ลบไฟล์ที่มีนามสกุล .mp3, .wav, .mp4, .mp4a ในโฟลเดอร์
         deleteAllMediaFiles('./public/uploads');
    } catch (error) {
        console.error('Error processing file: ', error.message);
        res.status(500).send(`Error processing file: ${error.message}`);
    }
});

// ฟังก์ชันสำหรับลบไฟล์ที่มีนามสกุล .mp3, .wav, .mp4
function deleteAllMediaFiles(directory) {
    fs.readdir(directory, (err, files) => {
        if (err) {
            console.error(`Unable to read directory: ${err.message}`);
            return;
        }

        files.forEach(file => {
            const filePath = path.join(directory, file);
            const extname = path.extname(file).toLowerCase();
            
            // ลบไฟล์ที่มีนามสกุล .mp3, .wav, .mp4
            if (extname === '.mp3' || extname === '.wav' || extname === '.mp4' || extname === '.mp4a') {
                fs.unlink(filePath, (err) => {
                    if (err) {
                        console.error(`Error deleting file ${filePath}: ${err.message}`);
                    } else {
                        console.log(`File ${filePath} deleted successfully.`);
                    }
                });
            }
        });
    });
}

// Function to rename the file to "audio.wav"
function renameFileToAudio(filePath, outputWavPath) {
    return new Promise((resolve, reject) => {
        fs.rename(filePath, outputWavPath, function (err) {
            if (err) {
                return reject(err);
            }
            resolve();
        });
    });
}

// Convert function with promises
function convertToWav(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .audioChannels(1)  // Ensure audio is mono
            .audioFrequency(16000)  // Set sample rate to 16kHz
            .toFormat('wav')
            .on('end', resolve)
            .on('error', reject)
            .save(outputPath);
    });
}

// Function to process audio with Microsoft Cognitive Services Speech SDK
function processAudio(filename, res) {
    return new Promise((resolve, reject) => {
        let wav = new WaveFile(fs.readFileSync(filename));
        wav.toSampleRate(16000);  // Ensure sample rate is 16000 Hz
        fs.writeFileSync("./public/uploads/audio.wav", wav.toBuffer());  // Save to 16000Hz, mono

        var newFilePath = "./public/uploads/audio.wav";  // Use updated file path
        var pushStream = sdk.AudioInputStream.createPushStream();
        fs.createReadStream(newFilePath).on('data', function (arrayBuffer) {
            pushStream.write(arrayBuffer.slice());
        }).on('end', function () {
            pushStream.close();
        });

        console.log("Now recognizing from: " + newFilePath);
        var audioConfig = sdk.AudioConfig.fromStreamInput(pushStream);
        var speechConfig = sdk.SpeechConfig.fromSubscription(subscriptionKey, serviceRegion);
        speechConfig.enableDictation();
        speechConfig.speechRecognitionLanguage = selectedlang;
        var recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

        recognizer.recognized = (s, e) => {
            if (e.result.reason == sdk.ResultReason.RecognizedSpeech) {
                console.log(`Recognized Text: ${e.result.text}`);
                res.write(e.result.text + "\n");  // Send partial results back to frontend immediately
                res.flush();  // Ensure the data is flushed and sent immediately
            } else if (e.result.reason == sdk.ResultReason.NoMatch) {
                console.log("NoMatch: Speech could not be recognized.");
            }
        };

        recognizer.sessionStopped = (s, e) => {
            res.end();  // End response after final recognition
            resolve();
        };

        recognizer.startContinuousRecognitionAsync();
    });
}

//// Server Activation
app.use("*", function (req, res) {
    res.sendFile(path1 + "404.html");
});
app.listen(port, function () {
    console.log(`App listening on http://localhost:${port}`);
});
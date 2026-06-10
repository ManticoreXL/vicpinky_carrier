import os
import time
import queue
import threading
import subprocess
import rclpy
from rclpy.node import Node
from rclpy.callback_groups import MutuallyExclusiveCallbackGroup
from rcl_interfaces.msg import SetParametersResult
from std_msgs.msg import String
from gtts import gTTS
import speech_recognition as sr

class VoiceNode(Node):
    def __init__(self):
        super().__init__('voice_node')

        # 1. Parameter 선언 및 기본값 설정
        self.declare_parameter('stt_language', 'ko-KR')
        self.declare_parameter('tts_language', 'ko')
        self.declare_parameter('ambient_noise_duration', 2.0)
        self.declare_parameter('phrase_time_limit', 5)
        self.declare_parameter('howling_delay', 0.5)
        self.declare_parameter('stt_timer_period', 0.1)
        self.declare_parameter('audio_player_cmd', 'mpg123')
        self.declare_parameter('temp_audio_path', '/tmp/tts_output.mp3')
        self.declare_parameter('mic_keywords', ['googlevoicehat', 'i2s', 'snd_rpi'])
        self.declare_parameter('pause_threshold', 0.5)
        self.declare_parameter('energy_threshold', 200)
        self.declare_parameter('dynamic_energy_threshold', False)
        self.declare_parameter('tts_tld', 'co.kr')

        # 2. Parameter 값 추출 및 인스턴스 변수 할당
        self.stt_language = self.get_parameter('stt_language').value
        self.tts_language = self.get_parameter('tts_language').value
        ambient_noise_duration = self.get_parameter('ambient_noise_duration').value
        phrase_time_limit = self.get_parameter('phrase_time_limit').value
        self.howling_delay = self.get_parameter('howling_delay').value
        stt_timer_period = self.get_parameter('stt_timer_period').value
        self.audio_player_cmd = self.get_parameter('audio_player_cmd').value
        self.temp_audio_path = self.get_parameter('temp_audio_path').value
        self.mic_keywords = self.get_parameter('mic_keywords').value
        pause_threshold = self.get_parameter('pause_threshold').value
        energy_threshold = self.get_parameter('energy_threshold').value
        dynamic_energy_threshold = self.get_parameter('dynamic_energy_threshold').value
        self.tts_tld = self.get_parameter('tts_tld').value

        self.tts_cb_group = MutuallyExclusiveCallbackGroup()
        self.timer_cb_group = MutuallyExclusiveCallbackGroup()

        self.stt_pub = self.create_publisher(
            String,
            'recognized_text',
            10
        )

        self.tts_sub = self.create_subscription(
            String,
            'speak_cmd',
            self.speak_callback,
            10,
            callback_group=self.tts_cb_group
        )

        self.is_speaking = False
        self.stt_queue = queue.Queue()

        self.stt_timer = self.create_timer(
            stt_timer_period,
            self.process_stt_queue,
            callback_group=self.timer_cb_group
        )

        # 파라미터 변경 콜백 등록 (실행 중 동적 변경 대응)
        self.add_on_set_parameters_callback(self.parameters_callback)

        self.recognizer = sr.Recognizer()
        self.recognizer.pause_threshold = pause_threshold
        self.recognizer.energy_threshold = energy_threshold
        self.recognizer.dynamic_energy_threshold = dynamic_energy_threshold

        self.mic = self.find_i2s_microphone()

        if self.mic:
            self.get_logger().info("Adjusting for ambient noise. Please wait...")
            
            with self.mic as source:
                self.recognizer.adjust_for_ambient_noise(
                    source, 
                    duration=ambient_noise_duration
                )
            
            self.stop_listening = self.recognizer.listen_in_background(
                self.mic, 
                self.stt_callback, 
                phrase_time_limit=phrase_time_limit
            )
            self.get_logger().info("Voice Node Initialization Complete. Listening in background...")
        else:
            self.get_logger().error("I2S Microphone not found. STT feature disabled.")

    def parameters_callback(self, params):
        successful = True
        reason = "Parameters updated successfully"

        for param in params:
            if param.name == 'howling_delay':
                self.howling_delay = param.value
                self.get_logger().info(f"Parameter updated: howling_delay = {param.value}")
            elif param.name == 'stt_language':
                self.stt_language = param.value
                self.get_logger().info(f"Parameter updated: stt_language = {param.value}")
            elif param.name == 'tts_language':
                self.tts_language = param.value
                self.get_logger().info(f"Parameter updated: tts_language = {param.value}")
            elif param.name == 'audio_player_cmd':
                self.audio_player_cmd = param.value
                self.get_logger().info(f"Parameter updated: audio_player_cmd = {param.value}")
            elif param.name == 'temp_audio_path':
                self.temp_audio_path = param.value
                self.get_logger().info(f"Parameter updated: temp_audio_path = {param.value}")
            elif param.name == 'tts_tld':
                self.tts_tld = param.value
                self.get_logger().info(f"Parameter updated: tts_tld = {param.value}")
            
            # STT 백그라운드 스레드 재시작이 필요한 파라미터들은 런타임 변경 거부
            elif param.name in ['ambient_noise_duration', 'phrase_time_limit', 'mic_keywords', 'stt_timer_period']:
                successful = False
                reason = f"Parameter '{param.name}' cannot be dynamically changed after initialization."
                self.get_logger().warn(reason)
                break

        return SetParametersResult(successful=successful, reason=reason)

    def find_i2s_microphone(self):
        mic_names = sr.Microphone.list_microphone_names()
        self.get_logger().info("--- Available Audio Devices ---")

        for index, name in enumerate(mic_names):
            self.get_logger().info(f"[{index}] {name}")
            
            # 파라미터로 받은 키워드 리스트와 매칭 검사
            if any(keyword.lower() in name.lower() for keyword in self.mic_keywords):
                self.get_logger().info(f"Found I2S Mic at index {index}")
                return sr.Microphone(device_index=index)
        
        self.get_logger().warn("Could not identify explicit I2S Mic. Falling back to default.")
        
        try:
            return sr.Microphone()
        except OSError:
            return None

    def stt_callback(self, recognizer, audio):
        if self.is_speaking:
            return
            
        try:
            text = recognizer.recognize_google(audio, language=self.stt_language)
            self.stt_queue.put(text)
        except sr.UnknownValueError:
            pass
        except sr.RequestError as e:
            self.get_logger().error(f"Google STT API Error: {e}")

    def process_stt_queue(self):
        while not self.stt_queue.empty():
            text = self.stt_queue.get()
            self.get_logger().info(f"[Heard]: {text}")
            msg = String()
            msg.data = text
            self.stt_pub.publish(msg)

    def speak_callback(self, msg):
        if self.is_speaking:
            self.get_logger().warn("Already speaking. Ignored new command.")
            return

        text = msg.data
        self.get_logger().info(f"[Speaking]: {text}")
        self.is_speaking = True
        
        tts_thread = threading.Thread(
            target=self.process_tts_and_play, 
            args=(text,)
        )
        tts_thread.start()

    def process_tts_and_play(self, text):
        try:
            tts = gTTS(text=text, lang=self.tts_language, tld=self.tts_tld)
            tts.save(self.temp_audio_path)
            
            subprocess.run([self.audio_player_cmd, "-q", self.temp_audio_path])
            
            if os.path.exists(self.temp_audio_path):
                os.remove(self.temp_audio_path)
                
        except Exception as e:
            self.get_logger().error(f"TTS Error: {e}")
            
        finally:
            time.sleep(self.howling_delay)
            self.is_speaking = False

def main(args=None):
    rclpy.init(args=args)
    node = VoiceNode()

    executor = rclpy.executors.MultiThreadedExecutor()
    executor.add_node(node)

    try:
        executor.spin()
    except KeyboardInterrupt:
        pass
    finally:
        if hasattr(node, 'stop_listening'):
            node.stop_listening(wait_for_stop=False)
        node.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
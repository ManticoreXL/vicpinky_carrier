#include "turtlebot3_hardware/led_driver.hpp"
#include <stdexcept>
#include <cstring>

LedDriver::LedDriver(int gpio_pin, int led_count)
    : current_state_(false), current_color_(0x00FFFFFF), led_count_(led_count) {
    
    // 구조체 초기화 (가비지 값 방지)
    std::memset(&ledstring_, 0, sizeof(ws2811_t));
    
    ledstring_.freq = WS2811_TARGET_FREQ;
    ledstring_.dmanum = 10;
    
    // 채널 0 설정 (네오픽셀 연결 핀)
    ledstring_.channel[0].gpionum = gpio_pin;
    ledstring_.channel[0].count = led_count;
    ledstring_.channel[0].invert = 0;
    ledstring_.channel[0].brightness = 255;
    ledstring_.channel[0].strip_type = WS2811_STRIP_GRB;
    
    // 채널 1 비활성화
    ledstring_.channel[1].gpionum = 0;
    ledstring_.channel[1].count = 0;
    ledstring_.channel[1].invert = 0;
    ledstring_.channel[1].brightness = 0;

    ws2811_return_t ret = ws2811_init(&ledstring_);
    if (ret != WS2811_SUCCESS) {
        throw std::runtime_error("ws2811_init failed: DMA or PWM busy");
    }
    
    set_state(false);
}

LedDriver::~LedDriver() {
    set_state(false);
    ws2811_fini(&ledstring_);
}

void LedDriver::set_color(uint8_t r, uint8_t g, uint8_t b) {
    // rpi_ws281x는 0x00RRGGBB 형태로 색상을 인식합니다.
    current_color_ = (r << 16) | (g << 8) | b;
    if (current_state_) {
        render();
    }
}

void LedDriver::set_state(bool state) {
    current_state_ = state;
    render();
}

bool LedDriver::get_state() const {
    return current_state_;
}

void LedDriver::render() {
    uint32_t color = current_state_ ? current_color_ : 0x00000000;
    for (int i = 0; i < led_count_; i++) {
        ledstring_.channel[0].leds[i] = color;
    }
    ws2811_render(&ledstring_);
}
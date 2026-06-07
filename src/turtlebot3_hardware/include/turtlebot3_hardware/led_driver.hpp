#ifndef LED_DRIVER_HPP
#define LED_DRIVER_HPP

#include <cstdint>
#include <ws2811.h>

class LedDriver {
public:
    LedDriver(int gpio_pin, int led_count);
    ~LedDriver();

    void set_state(bool state);
    bool get_state() const;
    void set_color(uint8_t r, uint8_t g, uint8_t b);

private:
    ws2811_t ledstring_;
    bool current_state_;
    uint32_t current_color_;
    int led_count_;

    void render();
};

#endif // LED_DRIVER_HPP